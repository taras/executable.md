import type { Database } from "../storage.js";
export type ResolveCacheHit = {
    kind: "inode";
    inode: number;
} | {
    kind: "negative";
};
export declare function lookupResolveCache(db: Database, canonicalPath: string): ResolveCacheHit | undefined;
export declare function storeResolveCache(db: Database, canonicalPath: string, inode: number | null): void;
export declare function invalidateResolveExact(db: Database, canonicalPath: string): void;
export declare function invalidateResolveSubtree(db: Database, canonicalPath: string): void;
export declare function clearResolveCache(db: Database): void;
