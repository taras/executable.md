import type { Database } from "../storage.js";
export interface RmOptions {
    recursive?: boolean;
    force?: boolean;
}
export declare function rm(db: Database, path: string, options: RmOptions): void;
