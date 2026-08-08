import type { Database } from "../storage.js";
export declare function symlink(db: Database, target: string, path: string, now: () => number): void;
