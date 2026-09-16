// ===========================================================================
// sleeveCache.js

/**
 * Sleeve artwork caching module.
 * Unlike the lyrics cache this one is written to disk, because a lookup costs
 * several rate-limited MusicBrainz requests and the answer almost never
 * changes. Surviving a restart is the difference between artwork appearing
 * instantly and the screen sitting empty for ten seconds after every reboot.
 * @module
 */

// Other modules
const path = require("path");
const { createStorage } = require("unstorage");
const fsLite = require("unstorage/drivers/fs-lite");
const log = require("debug")("lib:sleeve-cache");

// Negative results are kept too, so an album with nothing scanned is not
// looked up again on every play - but for a shorter time, since artwork does
// get added to the archive.
const TTL_FOUND_MS = 1000 * 60 * 60 * 24 * 90; // 90 days
const TTL_MISSING_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

/**
 * Initializes file storage cache
 */
const storage = createStorage({
    driver: fsLite({
        base: path.join(__dirname, "..", "cache", "sleeve")
    })
});

/**
 * Get an item from cache, honouring its age.
 * @param {string} key
 * @returns {Promise<object|null>}
 */
async function get(key) {
    let value = null;
    try {
        value = await storage.getItem(key);
    } catch (err) {
        log("GET failed:", key, err.message);
        return null;
    }
    if (!value) {
        log("GET:", "MISS", key);
        return null;
    }

    const ttl = (value.status === "ok") ? TTL_FOUND_MS : TTL_MISSING_MS;
    if (!value.cachedAt || (Date.now() - value.cachedAt) > ttl) {
        log("GET:", "STALE", key);
        await remove(key);
        return null;
    }

    log("GET:", "HIT [" + value.status + "]", key);
    return value;
}

/**
 * Store an item to cache, stamped so it can expire.
 * @param {string} key
 * @param {object} val
 * @returns {Promise<undefined>}
 */
async function set(key, val) {
    log("SET:", `[${val?.status}]`, key);
    try {
        await storage.setItem(key, { ...val, cachedAt: Date.now() });
    } catch (err) {
        // A cache that cannot be written is not a reason to fail the lookup.
        log("SET failed:", key, err.message);
    }
}

/**
 * Removes an item from cache
 * @param {string} key
 * @returns {Promise<undefined>}
 */
async function remove(key) {
    log("REMOVE:", key);
    try {
        await storage.removeItem(key, { removeMeta: true });
    } catch (err) {
        log("REMOVE failed:", key, err.message);
    }
}

/**
 * Count the number of items in cache
 * @returns {Promise<number>}
 */
async function count() {
    try {
        const keys = await storage.getKeys();
        return keys.length;
    } catch (err) {
        return 0;
    }
}

/**
 * Clears the entire cache
 * @returns {Promise<undefined>}
 */
async function clear() {
    log("CLEAR: Clearing sleeve cache");
    try {
        await storage.clear();
    } catch (err) {
        log("CLEAR failed:", err.message);
    }
}

module.exports = {
    get,
    set,
    remove,
    count,
    clear
};
