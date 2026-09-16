const sleeveCache = require("../lib/sleeveCache.js");

jest.mock("debug", () => () => jest.fn());

const DAY_MS = 1000 * 60 * 60 * 24;

describe("Sleeve Cache Module", () => {

    beforeEach(async () => {
        await sleeveCache.clear();
    });

    afterAll(async () => {
        await sleeveCache.clear();
    });

    test("stores and returns an entry", async () => {
        await sleeveCache.set("artist_album", { status: "ok", images: [{ url: "u", type: "Back" }] });

        const value = await sleeveCache.get("artist_album");

        expect(value).not.toBeNull();
        expect(value.status).toBe("ok");
        expect(value.images).toHaveLength(1);
    });

    test("returns null for something never stored", async () => {
        expect(await sleeveCache.get("nothing_here")).toBeNull();
    });

    test("survives being read back from disk", async () => {
        // The point of using the filesystem rather than memory: a restart must
        // not mean re-running every rate-limited lookup.
        await sleeveCache.set("persist_me", { status: "ok", images: [] });
        jest.resetModules();
        const reloaded = require("../lib/sleeveCache.js");

        expect(await reloaded.get("persist_me")).not.toBeNull();
    });

    test("removes an entry", async () => {
        await sleeveCache.set("artist_album", { status: "ok", images: [] });
        await sleeveCache.remove("artist_album");

        expect(await sleeveCache.get("artist_album")).toBeNull();
    });

    test("counts and clears", async () => {
        await sleeveCache.set("one_a", { status: "ok", images: [] });
        await sleeveCache.set("two_b", { status: "ok", images: [] });
        expect(await sleeveCache.count()).toBe(2);

        await sleeveCache.clear();
        expect(await sleeveCache.count()).toBe(0);
    });

    describe("expiry", () => {
        let now;

        beforeEach(() => {
            now = Date.now();
            jest.spyOn(Date, "now").mockReturnValue(now);
        });

        afterEach(() => {
            Date.now.mockRestore();
        });

        test("keeps a found entry for months", async () => {
            await sleeveCache.set("found_one", { status: "ok", images: [] });

            Date.now.mockReturnValue(now + (60 * DAY_MS));

            expect(await sleeveCache.get("found_one")).not.toBeNull();
        });

        test("drops a found entry once it is old enough", async () => {
            await sleeveCache.set("found_one", { status: "ok", images: [] });

            Date.now.mockReturnValue(now + (120 * DAY_MS));

            expect(await sleeveCache.get("found_one")).toBeNull();
        });

        test("expires a miss sooner than a hit, since artwork gets added", async () => {
            await sleeveCache.set("missing_one", { status: "not-found", images: [] });

            // Still inside the window a found entry would survive...
            Date.now.mockReturnValue(now + (30 * DAY_MS));

            expect(await sleeveCache.get("missing_one")).toBeNull();
        });
    });
});
