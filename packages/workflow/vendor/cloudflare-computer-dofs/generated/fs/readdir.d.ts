import type { Database } from "../storage.js";
export interface WorkspaceDirentResult {
    name: string;
    parentPath: string;
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
}
export interface ReaddirOptions {
    /** Maximum committed entries to materialize. Pending entries may extend the result. */
    limit?: number;
}
export declare function readdir(db: Database, path: string, options?: ReaddirOptions): WorkspaceDirentResult[];
