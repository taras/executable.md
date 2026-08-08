import type { DurableObjectStorageLike, SQLStorageLike } from "./types.js";
export declare class Database {
    #private;
    readonly sql: SQLStorageLike;
    readonly transactionSync: <T>(closure: () => T) => T;
    constructor(storage: DurableObjectStorageLike);
    get inTransaction(): boolean;
    run(query: string, ...bindings: unknown[]): void;
    all<Row extends object>(query: string, ...bindings: unknown[]): Row[];
    one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined;
    scalar<T>(query: string, ...bindings: unknown[]): T | undefined;
}
