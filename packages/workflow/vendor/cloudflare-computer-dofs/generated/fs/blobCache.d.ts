import type { Database } from "../storage.js";
export declare function getBlobBytes(db: Database, hash: Uint8Array): Uint8Array | undefined;
export declare function clearBlobCache(db: Database): void;
