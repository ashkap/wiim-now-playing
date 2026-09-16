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

    describe("stripEdition", () => {
        test("drops the edition wrapper a library adds", () => {
            expect(sleeve.stripEdition("Bad (Remastered)")).toBe("Bad");
            expect(sleeve.stripEdition("Watermark (2009 Remaster)")).toBe("Watermark");
            expect(sleeve.stripEdition("Led Zeppelin IV (Deluxe Edition)")).toBe("Led Zeppelin IV");
            expect(sleeve.stripEdition("Soul Junction - Remastered 2026")).toBe("Soul Junction");
            expect(sleeve.stripEdition("Ghostbusters (2016)")).toBe("Ghostbusters");
        });

        test("keeps a re-recording, which is a different album", () => {
            // Matching this to the original would show the wrong sleeve.
            expect(sleeve.stripEdition("1989 (Taylor's Version)")).toBe("1989 (Taylor's Version)");
        });

        test("leaves a plain title alone", () => {
            expect(sleeve.stripEdition("Skin")).toBe("Skin");
            expect(sleeve.stripEdition("Born to Run")).toBe("Born to Run");
        });
    });

    describe("primaryArtist", () => {
        test("reduces a credit to the headline artist", () => {
            expect(sleeve.primaryArtist("Taylor Swift feat. Post Malone")).toBe("Taylor Swift");
            expect(sleeve.primaryArtist("Eurythmics, Annie Lennox, Dave Stewart")).toBe("Eurythmics");
            expect(sleeve.primaryArtist("Denis Solee & The Beegie Adair Trio")).toBe("Denis Solee");
        });

        test("does not split a name that merely contains a joining word", () => {
            expect(sleeve.primaryArtist("Rag'n'Bone Man")).toBe("Rag'n'Bone Man");
        });
    });

    describe("getSleeveArt", () => {
        test("does nothing without an artist and album", async () => {
            const result = await sleeve.getSleeveArt("", "");
            expect(result.status).toBe("no-metadata");
            expect(https.get).not.toHaveBeenCalled();
        });

        test("returns a cached answer without touching the network", async () => {
            sleeveCache.get.mockResolvedValue({
                status: "ok", format: 2, images: [{ url: "u", type: "Back" }]
            });

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

        test("keeps the printed package and drops the disc, front and strips", async () => {
            queueResponses([
                { body: { releases: [{ id: "r1", title: "Kid A", "release-group": { id: "g1" } }] } },
                {
                    body: {
                        images: [
                            image(["Front"], "front"),
                            image(["Back"], "back"),
                            image(["Medium"], "disc"),
                            image(["Spine"], "spine"),
                            image([], "untyped"),
                            image(["Other"], "other"),
                            image(["Back"], "back-again"),
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
            expect(types).not.toContain("Medium"); // the disc is not the point
            expect(types).not.toContain("Spine"); // a sliver across half a screen
            expect(types).not.toContain("Other"); // no way to tell what it is
            expect(types.filter((t) => t === "Back")).toHaveLength(1); // one back, not two scans of it
            expect(result.images).toHaveLength(4); // back plus three booklet pages
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

        test("keeps printed artwork even when no pressing has a back", async () => {
            queueResponses([
                { body: { releases: [{ id: "r1", title: "Some Album" }] } },
                { body: { images: [image(["Front"], "front"), image(["Booklet"], "b1")] } }
            ]);

            const result = await sleeve.getSleeveArt("Some Artist", "Some Album");

            expect(result.status).toBe("ok");
            expect(result.hasBack).toBe(false);
            expect(result.images.map((i) => i.type)).toEqual(["Booklet"]);
        }, 20000);

        test("an album whose only extra is the disc gets no second panel", async () => {
            queueResponses([
                { body: { releases: [{ id: "r1", title: "Disc Only" }] } },
                { body: { images: [image(["Front"], "front"), image(["Medium"], "disc")] } },
                { body: { releases: [] } }
            ]);

            const result = await sleeve.getSleeveArt("Some Artist", "Disc Only");

            expect(result.status).toBe("not-found");
        }, 20000);

        test("retries with the edition stripped when the exact title misses", async () => {
            queueResponses([
                { body: { releases: [] } },                                   // "Bad (Remastered)"
                { body: { releases: [{ id: "r1", title: "Bad" }] } },         // "Bad"
                { body: { images: [image(["Front"], "f"), image(["Back"], "b")] } }
            ]);

            const result = await sleeve.getSleeveArt("Michael Jackson", "Bad (Remastered)");

            expect(result.status).toBe("ok");
            expect(result.hasBack).toBe(true);
        }, 30000);

        test("looks at every release group among the hits, not just the first", async () => {
            // A search for a reissue often puts a compilation at the top;
            // stopping there meant never reaching the group holding the album.
            queueResponses([
                { body: { releases: [
                    { id: "r1", title: "Hits", "release-group": { id: "gCompilation" } },
                    { id: "r2", title: "The Album", "release-group": { id: "gAlbum" } }
                ] } },
                { body: { images: [image(["Front"], "f1")] } },  // r1: nothing useful
                { body: { images: [image(["Front"], "f2")] } },  // r2: nothing useful
                { body: { releases: [{ id: "r3" }] } },          // first group
                { body: { images: [image(["Front"], "f3")] } },  // still nothing
                { body: { releases: [{ id: "r4" }] } },          // second group
                { body: { images: [image(["Back"], "b4")] } }    // found here
            ]);

            const result = await sleeve.getSleeveArt("Some Artist", "The Album");

            expect(result.status).toBe("ok");
            expect(result.release.id).toBe("r4");
        }, 30000);

        test("ignores an entry cached under older curation rules", async () => {
            // Otherwise a change to what the panel shows would never reach the
            // albums already looked up.
            sleeveCache.get.mockResolvedValue({
                status: "ok", format: 1, images: [{ url: "u", type: "Medium" }]
            });
            queueResponses([{ body: { releases: [] } }]);

            const result = await sleeve.getSleeveArt("Radiohead", "Kid A");

            expect(https.get).toHaveBeenCalled(); // looked it up again
            expect(result.status).toBe("not-found");
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
