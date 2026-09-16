// ===========================================================================
// sleeve.js

/**
 * Sleeve artwork module.
 * Finds scans of the printed package for the album that is playing - the back
 * cover first, then the tray card, booklet and liner notes - so Sleeve mode can
 * show the record as an object rather than just its front cover. Photographs of
 * the disc itself are deliberately left out; this panel is for the paper.
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
const MAX_SIBLING_RELEASES = 14; // other pressings checked, across all groups
const MAX_GROUPS = 3;           // distinct release groups among the search hits
const MAX_PANELS = 12;          // images handed to the client to cycle through
// How many of each type are worth cycling through. A record has one back
// cover and one tray card, so extras are duplicate scans of the same thing;
// booklets, digipak panels and inner sleeves are genuinely different pages.
const MAX_PER_TYPE = { Back: 1, Tray: 1, Poster: 1, Booklet: 3, Panel: 3, Liner: 3 };
const MAX_PER_TYPE_DEFAULT = 1;

// Bump when the curation rules change: entries cached under the old rules
// would otherwise keep serving images the new rules exclude. Widening the
// search is not a reason to bump it - that changes which albums are found,
// not what is shown for one already found, so the successful entries stay
// valid and only the misses are worth discarding.
const CACHE_FORMAT = 2;

// The printed parts of the package, in the order they are worth looking at.
// An allow-list rather than a list of things to drop: the archive has types
// this was never written against, and the cost of letting an unknown one
// through is a photograph of a disc appearing in a panel meant for the paper.
//
// Left out on purpose: Front (that is the other panel), Medium (the disc or
// record itself), Spine, Obi, Sticker, Top and Bottom (strips that would be
// stretched across half a screen as a sliver), Matrix/Runout and Raw/Unedited
// (collector documentation, not artwork), and Other and untyped scans, which
// give no clue what they are. Across 300 albums, allowing Other added no
// albums at all - everything that has one also has proper printed artwork.
const TYPE_ALLOW = ["Back", "Tray", "Booklet", "Liner", "Panel", "Poster"];

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
        const allowed = types.filter((t) => TYPE_ALLOW.indexOf(t) !== -1);
        if (!allowed.length) {
            return;
        }
        const url = imageUrl(image);
        if (!url) {
            return;
        }

        // Rank by the best-placed type this image carries. Untyped scans are
        // usually package shots, so they are kept but sorted to the end.
        // Rank by the best-placed type this image carries.
        let rank = TYPE_ALLOW.length;
        allowed.forEach((t) => {
            const at = TYPE_ALLOW.indexOf(t);
            if (at < rank) {
                rank = at;
            }
        });

        usable.push({
            url: url,
            type: TYPE_ALLOW[rank],
            rank: rank
        });
    });

    usable.sort((a, b) => a.rank - b.rank);

    // Cap each type, so neither a dozen booklet pages nor three scans of the
    // same back cover crowd out everything else. Variety is the point.
    const perType = {};
    return usable.filter((i) => {
        const cap = Object.prototype.hasOwnProperty.call(MAX_PER_TYPE, i.type)
            ? MAX_PER_TYPE[i.type]
            : MAX_PER_TYPE_DEFAULT;
        perType[i.type] = (perType[i.type] || 0) + 1;
        return perType[i.type] <= cap;
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
        format: CACHE_FORMAT,
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
 * Drop the edition wrapper from an album title.
 * The device reports what the library calls the record - "Bad (Remastered)",
 * "Watermark (2009 Remaster)" - while the archive catalogues it under the
 * plain title. Any pressing will do here, so the suffix is noise.
 *
 * Note what is deliberately not stripped: "(Taylor's Version)" and the like
 * name a genuinely different recording, not a reissue of the same one, and
 * matching those to the original would show the wrong sleeve.
 * @param {string} album
 * @returns {string}
 */
const stripEdition = (album) => {
    const editionWords = "remaster|remastered|deluxe|expanded|anniversary|edition|reissue|mono|stereo|bonus|special|collector|super";
    return String(album || "")
        // "(Deluxe Edition)", "[2009 Remaster]", "(25th Anniversary)"
        .replace(new RegExp("\\s*[\\(\\[][^)\\]]*(?:" + editionWords + ")[^)\\]]*[\\)\\]]", "gi"), "")
        // A bare year in brackets: "(2016)"
        .replace(/\s*[\(\[](?:19|20)\d{2}[\)\]]/g, "")
        // Trailing "- Remastered 2011", "- 2009 Remaster", "- Deluxe Edition"
        .replace(new RegExp("\\s*[-\u2013\u2014]\\s*(?:(?:19|20)\\d{2}\\s*)?(?:" + editionWords + ")[^,]*$", "i"), "")
        .replace(/\s{2,}/g, " ")
        .trim();
};

/**
 * Reduce a credit string to the primary artist.
 * The device reports the full credit - "Taylor Swift feat. Post Malone" -
 * which matches nothing, because the archive files the release under the
 * headline artist.
 * @param {string} artist
 * @returns {string}
 */
const primaryArtist = (artist) => {
    return String(artist || "")
        .split(/\s*(?:feat\.|featuring|ft\.|,|&|\bwith\b|\bvs\.?\b|\band\b)\s*/i)[0]
        .trim();
};

/**
 * The searches to try, in order, stopping at the first that matches.
 * @param {string} artist
 * @param {string} album
 * @returns {Array<string>}
 */
const buildQueries = (artist, album) => {
    const a = escapeQuery(artist);
    const b = escapeQuery(album);
    const queries = [`artist:"${a}" AND release:"${b}"`];

    const a2 = primaryArtist(a);
    const b2 = stripEdition(b);
    if (a2 && b2 && (a2 !== a || b2 !== b)) {
        queries.push(`artist:"${a2}" AND release:"${b2}"`);
    }
    return queries;
};

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
    if (cached && cached.format === CACHE_FORMAT) {
        return cached;
    }

    log("Looking up sleeve artwork for:", artist, "-", album);

    // The exact title first, then a relaxed one with the edition wrapper and
    // any featured artists removed. Libraries name records more specifically
    // than the archive catalogues them, and any pressing will do here.
    let releases = [];
    for (const query of buildQueries(artist, album)) {
        const search = await musicBrainz(
            "release/?query=" + encodeURIComponent(query) + "&fmt=json&limit=8"
        );
        // A null search is a failed request, not an album nobody has heard of.
        // Caching that as a miss would keep the screen empty for a fortnight
        // over one throttled lookup, so it is returned uncached and retried.
        if (!search) {
            log("Lookup failed (no answer from MusicBrainz) for", key);
            return { status: "error", key: key, images: [] };
        }
        releases = Array.isArray(search.releases) ? search.releases : [];
        log("Search returned", releases.length, "releases for", key, "via", query);
        if (releases.length) {
            break;
        }
    }

    if (!releases.length) {
        const miss = { status: "not-found", format: CACHE_FORMAT, key: key, images: [] };
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
    //
    // Every distinct group among the hits, not just the first: a search for a
    // reissue often puts a compilation or a different edition at the top, and
    // stopping there meant never looking at the group that holds the album.
    const groupIds = [];
    releases.forEach((release) => {
        const id = release["release-group"] && release["release-group"].id;
        if (id && groupIds.indexOf(id) === -1 && groupIds.length < MAX_GROUPS) {
            groupIds.push(id);
        }
    });

    // One budget across all the groups, so widening the search cannot turn a
    // miss into a minute of requests.
    let checked = 0;
    for (const groupId of groupIds) {
        if (checked >= MAX_SIBLING_RELEASES) {
            break;
        }
        const group = await musicBrainz(
            "release?release-group=" + encodeURIComponent(groupId) + "&fmt=json&limit=25"
        );
        const siblings = (group && Array.isArray(group.releases)) ? group.releases : [];
        log("  release group", groupId, "->", siblings.length, "other pressings");
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

    const miss = { status: "not-found", format: CACHE_FORMAT, key: key, images: [] };
    await sleeveCache.set(key, miss);
    return miss;
};

module.exports = {
    getSleeveArt,
    buildKey,
    // Exported for testing: these two decide whether an album is found at all.
    stripEdition,
    primaryArtist
};
