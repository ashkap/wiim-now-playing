// ===========================================================================
// sleeve.js

/**
 * Sleeve artwork module.
 * Finds scans of the physical package for the album that is playing - the back
 * cover first, then the disc face, booklet and the rest - so Sleeve mode can
 * show the record as an object rather than just its front cover.
 *
 * Resolution goes MusicBrainz (which release is this?) then Cover Art Archive
 * (what has been scanned for it?). The device itself only ever gives us a
 * front cover, so there is no shortcut around the lookup.
 * @module
 */

const https = require("https");
const sleeveCache = require("./sleeveCache.js");
const log = require("debug")("lib:sleeve");

const MB_HOST = "https://musicbrainz.org/ws/2/";
const CAA_HOST = "https://coverartarchive.org/";

// MusicBrainz requires a User-Agent that identifies the application.
const USER_AGENT = "wiim-now-playing/1.9.11 ( https://github.com/cvdlinden/wiim-now-playing )";

// MusicBrainz asks for no more than one request per second and starts handing
// back "server is busy" bodies well before that if you burst.
const MB_MIN_INTERVAL_MS = 1200;
const MB_RETRIES = 3;
const MB_BACKOFF_MS = 3000;

// The archive redirects its JSON and its images on to archive.org.
const MAX_REDIRECTS = 4;

// How far to look before giving up. Each step is a network round trip, so
// these caps are what keep a miss from taking a minute.
const MAX_SEARCH_RELEASES = 3;  // candidates from the initial title search
const MAX_SIBLING_RELEASES = 8; // other pressings of the same release group
const MAX_PANELS = 12;          // images handed to the client to cycle through
const MAX_PER_TYPE = 3;         // stops booklet scans swamping everything else

// Ordered by how much they look like "the back of the record". Anything not
// listed here is shown last; Front is dropped because it is the other panel,
// and the collector-oriented scans are dropped because they are not artwork.
const TYPE_ORDER = ["Back", "Medium", "Tray", "Booklet", "Spine", "Obi", "Liner", "Sticker", "Poster"];
const TYPE_EXCLUDE = ["Front", "Raw/Unedited", "Matrix/Runout", "Watermark"];

/**
 * Promise-friendly delay.
 * @param {number} ms
 * @returns {Promise<undefined>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch and parse JSON over https, forcing IPv4.
 * Matches the album art proxy: these hosts advertise IPv6, and on a network
 * with no working IPv6 route the request fails rather than falling back.
 *
 * Follows redirects, because the Cover Art Archive does not serve its own
 * JSON - every request is a 307 on to archive.org.
 * @param {string} url
 * @param {number} timeoutMs
 * @param {number} hops - Redirects already followed.
 * @returns {Promise<object|null>}
 */
const fetchJson = (url, timeoutMs = 15000, hops = 0) => {
    return new Promise((resolve) => {
        const options = {
            family: 4,
            headers: {
                "User-Agent": USER_AGENT,
                "Accept": "application/json"
            }
        };

        const request = https.get(url, options, (resp) => {
            // Cover Art Archive answers 404 for a release it holds nothing for,
            // which is an answer rather than a failure.
            if (resp.statusCode === 404) {
                resp.resume();
                resolve({ notFound: true });
                return;
            }

            if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
                resp.resume();
                if (hops >= MAX_REDIRECTS) {
                    resolve(null);
                    return;
                }
                // Upgrade rather than follow in the clear: the archive answers
                // on https, and these hops are otherwise plain http.
                const next = new URL(resp.headers.location, url);
                if (next.protocol === "http:") {
                    next.protocol = "https:";
                }
                resolve(fetchJson(next.href, timeoutMs, hops + 1));
                return;
            }

            if (resp.statusCode < 200 || resp.statusCode >= 300) {
                resp.resume();
                resolve(null);
                return;
            }

            let body = "";
            resp.setEncoding("utf8");
            resp.on("data", (chunk) => { body += chunk; });
            resp.on("end", () => {
                try {
                    resolve(JSON.parse(body));
                } catch (err) {
                    resolve(null);
                }
            });
        });

        request.setTimeout(timeoutMs, () => {
            request.destroy();
            resolve(null);
        });
        request.on("error", () => resolve(null));
    });
};

// MusicBrainz requests are serialised through this chain so the whole server
// makes at most one per MB_MIN_INTERVAL_MS, no matter how many screens ask.
let mbChain = Promise.resolve();
let mbLastAt = 0;

/**
 * Queue a MusicBrainz request, spacing it from the previous one.
 * The chain deliberately never rejects: one failed lookup must not break
 * every lookup queued behind it.
 * @param {string} path - Path and query below the ws/2 root.
 * @returns {Promise<object|null>}
 */
const musicBrainz = (path) => {
    return new Promise((resolve) => {
        mbChain = mbChain.then(async () => {
            let result = null;
            for (let attempt = 0; attempt <= MB_RETRIES; attempt++) {
                const wait = MB_MIN_INTERVAL_MS - (Date.now() - mbLastAt);
                if (wait > 0) {
                    await sleep(wait);
                }

                const body = await fetchJson(MB_HOST + path);
                mbLastAt = Date.now();

                // MusicBrainz signals throttling with a 200 and an error body,
                // so an empty result is not by itself evidence of no match.
                if (body && !body.error) {
                    result = body;
                    break;
                }
                if (body && body.error) {
                    log("MusicBrainz busy, backing off:", body.error);
                }
                // A busy MusicBrainz stays busy for longer than the polite
                // interval, so back off hard rather than burning the retries.
                // No point waiting after the last attempt.
                if (attempt < MB_RETRIES) {
                    await sleep(MB_BACKOFF_MS * (attempt + 1));
                }
            }
            resolve(result);
        });
    });
};

/**
 * Ask the Cover Art Archive what has been scanned for a release.
 * @param {string} mbid
 * @returns {Promise<Array<object>>} Raw image entries, empty if none.
 */
const coverArtFor = async (mbid) => {
    const body = await fetchJson(CAA_HOST + "release/" + encodeURIComponent(mbid));
    if (!body || body.notFound || !Array.isArray(body.images)) {
        return [];
    }
    return body.images;
};

/**
 * Pick the best available size and make sure it is https.
 * The archive hands back http URLs, and these are fetched through the art
 * proxy, which only accepts https.
 * @param {object} image
 * @returns {string|null}
 */
const imageUrl = (image) => {
    const thumbs = image.thumbnails || {};
    // 1200 is comfortably more than a half-screen panel needs and keeps the
    // decode cheap on a Pi; the full-size scans can be several thousand pixels.
    const chosen = thumbs["1200"] || thumbs.large || thumbs["500"] || image.image;
    if (!chosen) {
        return null;
    }
    return String(chosen).replace(/^http:\/\//i, "https://");
};

/**
 * Turn raw archive entries into an ordered list of panels worth showing.
 * @param {Array<object>} images
 * @returns {Array<object>}
 */
const orderImages = (images) => {
    const usable = [];

    images.forEach((image) => {
        const types = Array.isArray(image.types) ? image.types : [];
        if (types.some((t) => TYPE_EXCLUDE.indexOf(t) !== -1)) {
            return;
        }
        const url = imageUrl(image);
        if (!url) {
            return;
        }

        // Rank by the best-placed type this image carries. Untyped scans are
        // usually package shots, so they are kept but sorted to the end.
        let rank = TYPE_ORDER.length;
        types.forEach((t) => {
            const at = TYPE_ORDER.indexOf(t);
            if (at !== -1 && at < rank) {
                rank = at;
            }
        });

        usable.push({
            url: url,
            type: types.length ? types[0] : "Other",
            rank: rank
        });
    });

    usable.sort((a, b) => a.rank - b.rank);

    // Cap each type so a release with a dozen booklet pages does not crowd out
    // the disc face and the tray card. Variety is the point of cycling.
    const perType = {};
    return usable.filter((i) => {
        perType[i.type] = (perType[i.type] || 0) + 1;
        return perType[i.type] <= MAX_PER_TYPE;
    }).map((i) => ({ url: i.url, type: i.type }));
};

/**
 * Whether this set of archive entries includes an actual back cover.
 * @param {Array<object>} images
 * @returns {boolean}
 */
const hasBack = (images) => images.some(
    (i) => Array.isArray(i.types) && i.types.indexOf("Back") !== -1
);

/**
 * Build the payload handed to the client.
 * @param {object} release
 * @param {Array<object>} images
 * @param {string} key
 * @returns {object}
 */
const buildResult = (release, images, key) => {
    return {
        status: "ok",
        key: key,
        release: {
            id: release.id,
            title: release.title || "",
            date: release.date || "",
            country: release.country || ""
        },
        hasBack: hasBack(images),
        images: orderImages(images).slice(0, MAX_PANELS)
    };
};

/**
 * Normalise artist and album into a stable cache key.
 * @param {string} artist
 * @param {string} album
 * @returns {string}
 */
const buildKey = (artist, album) => {
    const clean = (s) => String(s || "")
        .toLowerCase()
        .replace(/[\u2018\u2019\u201c\u201d]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
    return clean(artist) + "_" + clean(album);
};

/**
 * Escape a value for a Lucene field query.
 * @param {string} s
 * @returns {string}
 */
const escapeQuery = (s) => String(s || "").replace(/["\\]/g, " ").trim();

/**
 * Find scans of the physical package for an album.
 *
 * Looks at the closest title matches first, then at other pressings in the
 * same release group. That second step matters more than it sounds: the first
 * match often has nothing scanned while a reissue of the same record has a
 * full set, and without it most albums come back empty.
 *
 * @param {string} artist
 * @param {string} album
 * @returns {Promise<object>} Always resolves; status says what was found.
 */
const getSleeveArt = async (artist, album) => {
    if (!artist || !album) {
        return { status: "no-metadata", images: [] };
    }

    const key = buildKey(artist, album);
    const cached = await sleeveCache.get(key);
    if (cached) {
        return cached;
    }

    log("Looking up sleeve artwork for:", artist, "-", album);

    const query = `artist:"${escapeQuery(artist)}" AND release:"${escapeQuery(album)}"`;
    const search = await musicBrainz(
        "release/?query=" + encodeURIComponent(query) + "&fmt=json&limit=8"
    );
    // A null search is a failed request, not an album nobody has heard of.
    // Caching that as a miss would keep the screen empty for a fortnight over
    // one throttled lookup, so it is returned uncached and retried next time.
    if (!search) {
        log("Lookup failed (no answer from MusicBrainz) for", key);
        return { status: "error", key: key, images: [] };
    }

    const releases = Array.isArray(search.releases) ? search.releases : [];
    log("Search returned", releases.length, "releases for", key);

    if (!releases.length) {
        const miss = { status: "not-found", key: key, images: [] };
        await sleeveCache.set(key, miss);
        return miss;
    }

    // Track the best pressing seen rather than taking the first acceptable
    // one. Plenty of releases have a lone back cover scanned while another
    // pressing of the same record has the whole package, and for this mode
    // the richer one is the better answer.
    const seen = [];
    let best = null;

    const consider = (release, images) => {
        const usable = orderImages(images).length;
        if (!usable) {
            return false;
        }
        const back = hasBack(images);
        const better = !best
            || (back && !best.back)
            || (back === best.back && usable > best.usable);
        if (better) {
            best = { release: release, images: images, back: back, usable: usable };
        }
        // Good enough to stop looking: a back cover and the rest of the package.
        return back && usable >= 4;
    };

    for (const release of releases.slice(0, MAX_SEARCH_RELEASES)) {
        if (!release.id) {
            continue;
        }
        seen.push(release.id);
        const images = await coverArtFor(release.id);
        log("  candidate", release.id, "->", images.length, "images");
        if (consider(release, images)) {
            const found = buildResult(best.release, best.images, key);
            await sleeveCache.set(key, found);
            return found;
        }
    }

    // Nothing on the obvious matches; try the other pressings of the same
    // record. This is where most back covers actually turn up.
    const groupId = releases[0]["release-group"] && releases[0]["release-group"].id;
    if (groupId) {
        const group = await musicBrainz(
            "release?release-group=" + encodeURIComponent(groupId) + "&fmt=json&limit=25"
        );
        const siblings = (group && Array.isArray(group.releases)) ? group.releases : [];
        log("  release group", groupId, "->", siblings.length, "other pressings");
        let checked = 0;
        for (const sibling of siblings) {
            if (!sibling.id || seen.indexOf(sibling.id) !== -1) {
                continue;
            }
            if (checked >= MAX_SIBLING_RELEASES) {
                break;
            }
            checked++;
            const images = await coverArtFor(sibling.id);
            log("  sibling", sibling.id, "->", images.length, "images, back:", hasBack(images));
            if (consider(sibling, images)) {
                const found = buildResult(best.release, best.images, key);
                await sleeveCache.set(key, found);
                return found;
            }
        }
    }

    // Nothing ideal, but whatever package artwork turned up beats an empty
    // panel - a disc face or a booklet page is still the object.
    if (best) {
        const partial = buildResult(best.release, best.images, key);
        await sleeveCache.set(key, partial);
        return partial;
    }

    const miss = { status: "not-found", key: key, images: [] };
    await sleeveCache.set(key, miss);
    return miss;
};

module.exports = {
    getSleeveArt,
    buildKey
};
