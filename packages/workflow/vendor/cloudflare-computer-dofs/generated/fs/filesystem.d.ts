import type { Database } from "../storage.js";
import { type WorkspaceFoundEntry } from "./find.js";
import { type GrepOptions, type WorkspaceGrepMatch } from "./grep.js";
import { type MkdirOptions } from "./mkdir.js";
import { type ReaddirOptions, type WorkspaceDirentResult } from "./readdir.js";
import { type ReadFileOptions } from "./readFile.js";
import { type RmOptions } from "./rm.js";
import { type WorkspaceStatResult } from "./stat.js";
import { type WriteFileContent, type WriteFileOptions } from "./writeFile.js";
export interface WorkspaceFilesystemOptions {
    now?: () => number;
}
export declare class WorkspaceFilesystem {
    readonly db: Database;
    readonly now: () => number;
    constructor(db: Database, options?: WorkspaceFilesystemOptions);
    readFile(path: string): Promise<ReadableStream<Uint8Array>>;
    readFile(path: string, encoding: "utf8"): Promise<string>;
    readFile(path: string, options: ReadFileOptions): Promise<string | ReadableStream<Uint8Array>>;
    stat(path: string): Promise<WorkspaceStatResult>;
    lstat(path: string): Promise<WorkspaceStatResult>;
    readlink(path: string): Promise<string>;
    readdir(path: string, options?: ReaddirOptions): Promise<WorkspaceDirentResult[]>;
    find(directory: string, pattern?: string): Promise<WorkspaceFoundEntry[]>;
    ls(prefix: string): Promise<string[]>;
    grep(pattern: string, path: string, options?: GrepOptions): Promise<WorkspaceGrepMatch[]>;
    writeFile(path: string, content: WriteFileContent, options?: WriteFileOptions): Promise<void>;
    mkdir(path: string, options?: MkdirOptions): Promise<void>;
    rm(path: string, options?: RmOptions): Promise<void>;
    chmod(path: string, mode: number): Promise<void>;
    symlink(target: string, path: string): Promise<void>;
}
