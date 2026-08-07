import type { Database } from "../storage.js";
type NodeType = "file" | "dir" | "symlink";
export declare function unlinkDirent(db: Database, parentInode: number, name: string, childInode: number, type: NodeType): boolean;
export {};
