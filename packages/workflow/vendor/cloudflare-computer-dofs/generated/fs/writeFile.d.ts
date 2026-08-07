import type { Database } from "../storage.js";
export declare const CHUNK_SIZE: number;
export type WriteFileContent = string | Uint8Array | ReadableStream<Uint8Array>;
export interface WriteFileOptions {
    mode?: number;
    /** Fail with EEXIST when the target already exists. */
    exclusive?: boolean;
}
export interface WriteFileRange {
    start: number;
    end: number;
}
interface PreparedChunk {
    hash: Uint8Array;
    bytes: Uint8Array;
    size: number;
}
export declare function chunksOf(bytes: Uint8Array): PreparedChunk[];
export declare function writeFile(db: Database, path: string, content: WriteFileContent, options: WriteFileOptions, now: () => number): Promise<void>;
export declare function createFileSync(db: Database, path: string, options: WriteFileOptions, now: () => number): void;
export declare function openWriteBufferSync(db: Database, path: string): void;
export declare function openWriteBufferForCreateSync(db: Database, path: string, options: WriteFileOptions, now: () => number): void;
export declare function releaseWriteBufferSync(db: Database, path: string, now: () => number): void;
/**
 * @internal
 * Bridges a pending-create write buffer into the SQL world ahead of a
 * dirent-mutating provider operation (link, rename, unlink). Leaves
 * the open count untouched so a still-open handle keeps writing into
 * the now-promoted buffer. Returns true when a pending buffer was
 * committed. External callers should never invoke this directly.
 */
export declare function flushPendingByPath(db: Database, path: string, now: () => number): boolean;
export declare function writeRangeSync(db: Database, path: string, bytes: Uint8Array, offset: number, options: WriteFileOptions, now: () => number): number;
export declare function truncateFileSync(db: Database, path: string, size: number, now: () => number): void;
export declare function writeFileSync(db: Database, path: string, bytes: Uint8Array, options: WriteFileOptions, now: () => number): void;
export declare function writeFileRangesSync(db: Database, path: string, bytes: Uint8Array, dirtyRanges: WriteFileRange[], options: WriteFileOptions, now: () => number): void;
export {};
