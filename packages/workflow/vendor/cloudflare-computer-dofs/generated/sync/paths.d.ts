import type { Database } from "../storage.js";
export declare function pathOf(db: Database, inode: number): string | null;
export declare function pathsOf(db: Database, inode: number): string[];
