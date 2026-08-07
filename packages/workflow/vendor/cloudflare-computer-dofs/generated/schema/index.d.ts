import type { Database } from "../storage.js";
export { ROOT_INODE, SCHEMA_VERSION } from "./core.js";
export declare function initializeSchema(db: Database, now: () => number): void;
