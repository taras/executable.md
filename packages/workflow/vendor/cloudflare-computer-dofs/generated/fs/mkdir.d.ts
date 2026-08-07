import type { Database } from "../storage.js";
export interface MkdirOptions {
    recursive?: boolean;
    mode?: number;
}
export declare function mkdir(db: Database, path: string, options: MkdirOptions, now: () => number): void;
