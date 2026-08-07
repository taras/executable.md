import type { Database } from "../storage.js";
export declare function chmod(db: Database, path: string, mode: number, now: () => number): void;
