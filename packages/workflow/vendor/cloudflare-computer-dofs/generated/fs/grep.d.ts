import type { Database } from "../storage.js";
export interface WorkspaceGrepMatch {
    path: string;
    line: number;
    text: string;
}
export interface GrepOptions {
    ignoreCase?: boolean;
}
export declare function grep(db: Database, pattern: string, path: string, options?: GrepOptions): Promise<WorkspaceGrepMatch[]>;
