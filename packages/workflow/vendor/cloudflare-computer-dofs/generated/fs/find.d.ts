import type { Database } from "../storage.js";
export interface WorkspaceFoundEntry {
    path: string;
    type: "file" | "dir";
}
export declare function find(db: Database, directory: string, pattern?: string): WorkspaceFoundEntry[];
