import type { Database } from "../storage.js";
export interface WriteBufferEntry {
    buf: Uint8Array;
    size: number;
    dirty: boolean;
    openCount: number;
    mode: number;
    pending?: {
        parentInode: number;
        leafName: string;
        canonicalPath: string;
        pendingInode: number;
        mtime: number;
    };
}
export declare function getWriteBuffer(db: Database, inode: number): WriteBufferEntry | undefined;
export declare function getPendingWriteBufferByPath(db: Database, canonicalPath: string): WriteBufferEntry | undefined;
export declare function listPendingByParent(db: Database, parentInode: number): WriteBufferEntry[];
export declare function setWriteBuffer(db: Database, inode: number, entry: WriteBufferEntry): void;
export declare function deleteWriteBuffer(db: Database, inode: number): void;
export declare function allocatePendingInode(db: Database): number;
export declare function promotePendingToInode(db: Database, pendingInode: number, realInode: number): void;
export declare function ensureCapacity(entry: WriteBufferEntry, needed: number): void;
