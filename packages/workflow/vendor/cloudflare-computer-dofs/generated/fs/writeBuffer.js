// In-process write buffer cache.
//
// Holds per-inode mutable byte buffers between an explicit open and
// release. While a buffer is open, all reads and writes for that
// inode go through the buffer rather than the SQLite blob/chunk
// store. Release commits the bytes to chunks once per file
// and evicts the entry, so per-syscall writes no longer accumulate
// orphan blob rows in the store.
//
// The cache is keyed by Database so a fresh database (a test, a
// rebooted DO incarnation) starts with an empty cache.
const caches = new WeakMap();
function cacheFor(db) {
    let cache = caches.get(db);
    if (cache === undefined) {
        cache = { byInode: new Map(), byPendingPath: new Map(), nextPendingInode: -1 };
        caches.set(db, cache);
    }
    return cache;
}
export function getWriteBuffer(db, inode) {
    return caches.get(db)?.byInode.get(inode);
}
export function getPendingWriteBufferByPath(db, canonicalPath) {
    return caches.get(db)?.byPendingPath.get(canonicalPath);
}
// List pending-create buffers whose parent dirent matches `parentInode`.
// Used by readdir so freshly-created-but-not-yet-released files show
// up in directory listings between open and release.
export function listPendingByParent(db, parentInode) {
    const cache = caches.get(db);
    if (cache === undefined)
        return [];
    const out = [];
    for (const entry of cache.byPendingPath.values()) {
        if (entry.pending?.parentInode === parentInode)
            out.push(entry);
    }
    return out;
}
export function setWriteBuffer(db, inode, entry) {
    const cache = cacheFor(db);
    cache.byInode.set(inode, entry);
    if (entry.pending !== undefined) {
        cache.byPendingPath.set(entry.pending.canonicalPath, entry);
    }
}
export function deleteWriteBuffer(db, inode) {
    const cache = caches.get(db);
    if (cache === undefined)
        return;
    const entry = cache.byInode.get(inode);
    if (entry?.pending !== undefined) {
        cache.byPendingPath.delete(entry.pending.canonicalPath);
    }
    cache.byInode.delete(inode);
}
// Allocate a synthetic negative inode id for a pending file. The
// real id is assigned by SQLite when release INSERTs the node row;
// the synthetic value just lets the buffer cache key entries
// before that point.
export function allocatePendingInode(db) {
    const cache = cacheFor(db);
    const next = cache.nextPendingInode;
    cache.nextPendingInode -= 1;
    return next;
}
// Re-key a pending entry to the real inode assigned by SQLite at
// commit time, dropping the pending-path index.
export function promotePendingToInode(db, pendingInode, realInode) {
    const cache = caches.get(db);
    if (cache === undefined)
        return;
    const entry = cache.byInode.get(pendingInode);
    if (entry === undefined)
        return;
    if (entry.pending !== undefined) {
        cache.byPendingPath.delete(entry.pending.canonicalPath);
        entry.pending = undefined;
    }
    cache.byInode.delete(pendingInode);
    cache.byInode.set(realInode, entry);
}
export function ensureCapacity(entry, needed) {
    if (entry.buf.byteLength >= needed)
        return;
    let cap = Math.max(entry.buf.byteLength * 2, 64 * 1024);
    while (cap < needed)
        cap *= 2;
    const next = new Uint8Array(cap);
    next.set(entry.buf.subarray(0, entry.size), 0);
    entry.buf = next;
}
