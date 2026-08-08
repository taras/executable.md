import type { Database } from "../storage.js";
export interface WorkspaceStatResult {
    name: string;
    inode: number;
    mode: number;
    mtime: number;
    size: number;
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
}
export declare function stat(db: Database, path: string): WorkspaceStatResult;
export declare function lstat(db: Database, path: string): WorkspaceStatResult;
