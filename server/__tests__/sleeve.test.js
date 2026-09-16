const { EventEmitter } = require("events");

jest.mock("../lib/sleeveCache.js");
jest.mock("https");
jest.mock("debug", () => () => jest.fn());

// Re-acquired after every jest.resetModules(): resetting the registry hands
// the module under test a fresh copy of each mock, so holding references from
// the top of the file would configure the wrong objects.
let https;
let sleeveCache;

/**
 * Queue up responses, handed out in order to successive https.get calls.
 * @param {Array<object>} responses - { status, body } or { status, location }
 * @returns {undefined}
 */
const queueResponses = (responses) => {
    let call = 0;
    https.get.mockImplementation((url, options, callback) => {
        const spec = responses[call] || responses[responses.length - 1];
        call++;

        const res = new EventEmitter();
        res.statusCode = spec.status || 200;
        res.headers = spec.location ? { location: spec.location } : {};
        res.setEncoding = jest.fn();
        res.resume = jest.fn();

        // Deliver on the next tick, so the caller has attached its listeners.
        process.nextTick(() => {
            callback(res);
            if (!spec.location && spec.status !== 404) {
                res.emit("data", JSON.stringify(spec.body || {}));
                res.emit("end");
            }
        });

        return { setTimeout: jest.fn(), on: jest.fn() };
    });
};

const image = (types, id) => ({
    types: types,
    image: `http://coverartarchive.org/release/x/${id}.jpg`,
    thumbnails: { "1200": `http://coverartarchive.org/release/x/${id}-1200.jpg` }
});

describe("Sleeve Module", () => {
    let sleeve;

    beforeEach(() => {
        // Reset the module so its rate-limiter clock starts fresh and the
        // first MusicBrainz call of each test fires without waiting.
        jest.resetModules();
        https = require("https");
        sleeveCache = require("../lib/sleeveCache.js");
        sleeve = require("../lib/sleeve.js");
        jest.clearAllMocks();
        sleeveCache.get.mockResolvedValue(null);
        sleeveCache.set.mockResolvedValue(undefined);
    });

    describe("buildKey", () => {
        test("normalises case, punctuation and spacing", () => {
            expect(sleeve.buildKey("Bruce Springsteen", "Born to Run"))
                .toBe("bruce-springsteen_born-to-run");
            expect(sleeve.buildKey("BRUCE  SPRINGSTEEN!", "Born To Run"))
                .toBe("bruce-springsteen_born-to-run");
        });

        test("strips smart quotes so the same album keys alike", () => {
            expect(sleeve.buildKey("Guns N’ Roses", "Appetite for Destruction"))
                .toBe(sleeve.buildKey("Guns N Roses", "Appetite for Destruction"));
        });
    });

    describe("getSleeveArt", () => {
        test("does nothing without an artist and album", async () => {
            const result = await sleeve.getSleeveArt("", "");
            expect(result.status).toBe("no-metadata");
            expect(https.get).not.toHaveBeenCalled();
        });

        test("returns a cached answer without touching the network", async () => {
            sleeveCache.get.mockResolvedValue({ status: "ok", images: [{ url: "u", type: "Back" }] });

            const result = await sleeve.getSleeveArt("Radiohead", "Kid A");

            expect(result.status).toBe("ok");
            expect(https.get).not.toHaveBeenCalled();
        });

        test("a failed lookup is reported as an error and never cached", async () => {
            // A throttled or unreachable MusicBrainz must not be recorded as
            // "this album has no artwork" - that would persist for weeks.
            queueResponses([{ status: 503 }]);

            const result = await sleeve.getSleeveArt("Michael Jackson", "Thriller");

            expect(result.status).toBe("error");
            expect(sleeveCache.set).not.toHaveBeenCalled();
        }, 30000);

        test("caches a genuine miss", async () => {
            queueResponses([{ body: { releases: [] } }]);

            const result = await sleeve.getSleeveArt("Nobody", "Nothing");

            expect(result.status).toBe("not-found");
            expect(sleeveCache.set).toHaveBeenCalledWith(
                "nobody_nothing",
                expect.objectContaining({ status: "not-found" })
            );
        });

        test("retries a throttle body rather than reading it as a miss", async () => {
            queueResponses([
                { body: { error: "The MusicBrainz web server is currently busy." } },
                { body: { releases: [] } }
            ]);

            const result = await sleeve.getSleeveArt("Fleetwood Mac", "Rumours");

            expect(https.get).toHaveBeenCalledTimes(2);
            expect(result.status).toBe("not-found");
        }, 20000);

        test("returns the back cover, dropping the front and capping each type", async () => {
            queueResponses([
                { body: { releases: [{ id: "r1", title: "Kid A", "release-group": { id: "g1" } }] } },
                {
                    body: {
                        images: [
                            image(["Front"], "front"),
                            image(["Back"], "back"),
                            image(["Medium"], "disc"),
                            image(["Booklet"], "b1"),
                            image(["Booklet"], "b2"),
                            image(["Booklet"], "b3"),
                            image(["Booklet"], "b4")
                        ]
                    }
                }
            ]);

            const result = await sleeve.getSleeveArt("Radiohead", "Kid A");

            expect(result.status).toBe("ok");
            expect(result.hasBack).toBe(true);

            const types = result.images.map((i) => i.type);
            expect(types[0]).toBe("Back"); // the back leads
            expect(types).not.toContain("Front"); // that is the other panel
            expect(types.filter((t) => t === "Booklet")).toHaveLength(3); // capped

            // Fetched over https, whatever the archive advertised.
            result.images.forEach((i) => expect(i.url.startsWith("https://")).toBe(true));
        }, 20000);

        test("falls back to other pressings when the match has no back", async () => {
            // The common case by a distance: the closest title match has only a
            // front scanned, and a reissue of the same record has the package.
            queueResponses([
                { body: { releases: [{ id: "r1", title: "Kid A", "release-group": { id: "g1" } }] } },
                { body: { images: [image(["Front"], "front")] } },
                { body: { releases: [{ id: "r1" }, { id: "r2", title: "Kid A reissue" }] } },
                { body: { images: [image(["Front"], "f2"), image(["Back"], "back2")] } }
            ]);

            const result = await sleeve.getSleeveArt("Radiohead", "Kid A");

            expect(result.status).toBe("ok");
            expect(result.hasBack).toBe(true);
            expect(result.release.id).toBe("r2");
        }, 20000);

        test("keeps package artwork even when no pressing has a back", async () => {
            queueResponses([
                { body: { releases: [{ id: "r1", title: "Some Album" }] } },
                { body: { images: [image(["Front"], "front"), image(["Medium"], "disc")] } }
            ]);

            const result = await sleeve.getSleeveArt("Some Artist", "Some Album");

            expect(result.status).toBe("ok");
            expect(result.hasBack).toBe(false);
            expect(result.images.map((i) => i.type)).toEqual(["Medium"]);
        }, 20000);

        test("follows the archive's redirect instead of failing on it", async () => {
            // The Cover Art Archive never serves its own JSON; it is always a
            // 307 on to archive.org.
            queueResponses([
                { body: { releases: [{ id: "r1", title: "Kid A" }] } },
                { status: 307, location: "http://archive.org/download/mbid-r1/index.json" },
                { body: { images: [image(["Back"], "back")] } }
            ]);

            const result = await sleeve.getSleeveArt("Radiohead", "Kid A");

            expect(result.status).toBe("ok");
            expect(result.hasBack).toBe(true);
        }, 20000);
    });
});
