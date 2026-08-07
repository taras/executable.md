import type { Database } from "../storage.js";
export declare function recordDelete(db: Database, rev: number, path: string): void;
export type ChangeEntry = {
    kind: "file";
    rev: number;
    path: string;
    mode: number;
    mtime: number;
    size: number;
    chunks: {
        hash: Uint8Array;
        size: number;
    }[];
} | {
    kind: "dir";
    rev: number;
    path: string;
    mode: number;
    mtime: number;
} | {
    kind: "symlink";
    rev: number;
    path: string;
    target: string;
    mode: number;
    mtime: number;
} | {
    kind: "delete";
    rev: number;
    path: string;
};
export declare function materialiseChange(db: Database, path: string): ChangeEntry | null;
