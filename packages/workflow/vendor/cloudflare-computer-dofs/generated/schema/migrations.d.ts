import type { Database } from "../storage.js";
export interface Migration {
    readonly from: number;
    readonly to: number;
    readonly migrator: (db: Database) => void;
}
export declare const MIGRATIONS: readonly Migration[];
export declare function runMigrations(db: Database, current: number, target: number): number;
