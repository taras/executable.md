import type { Database } from "../storage.js";
export declare function invalidateReadOnlyMountCache(db: Database): void;
export declare function getReadOnlyMountRoots(db: Database): readonly string[];
export declare function assertNotReadOnly(db: Database, path: string): void;
export declare function readOnlyRootFor(db: Database, path: string): string | undefined;
