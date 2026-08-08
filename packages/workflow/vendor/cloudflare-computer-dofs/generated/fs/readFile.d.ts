import type { Database } from "../storage.js";
export interface ReadFileOptions {
    encoding?: "utf8";
}
export declare function readFile(db: Database, path: string): Promise<ReadableStream<Uint8Array>>;
export declare function readFile(db: Database, path: string, encoding: "utf8"): Promise<string>;
export declare function readFile(db: Database, path: string, options: ReadFileOptions): Promise<string | ReadableStream<Uint8Array>>;
export declare function readRangeSync(db: Database, path: string, offset: number, length: number): Uint8Array;
