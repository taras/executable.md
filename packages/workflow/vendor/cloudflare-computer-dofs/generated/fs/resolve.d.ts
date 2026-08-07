import type { Database } from "../storage.js";
export interface ResolvedInode {
    inode: number;
    type: "file" | "dir" | "symlink";
    mode: number;
    mtime: number;
    size: number;
    linkTarget?: string;
}
export interface ResolveOptions {
    followSymlinks?: boolean;
}
export declare function resolveInode(db: Database, path: string, options?: ResolveOptions): ResolvedInode | null;
