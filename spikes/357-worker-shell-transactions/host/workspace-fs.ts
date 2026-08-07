// @ts-types="../../351-worker-backends/host/types/dofs.d.ts"
import { Database, WorkspaceFilesystem } from "@cloudflare/dofs";
import type {
  GrepOptions,
  WorkspaceDirentResult,
  WorkspaceFoundEntry,
  WorkspaceGrepMatch,
  WorkspaceStatResult,
} from "../../351-worker-backends/host/types/dofs.d.ts";

export class WorkspaceFsShim {
  #fs: WorkspaceFilesystem;

  constructor(db: Database) {
    this.#fs = new WorkspaceFilesystem(db);
  }

  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readFile(
    path: string,
    encoding?: "utf8",
  ): Promise<string | ReadableStream<Uint8Array>> {
    return encoding === "utf8"
      ? this.#fs.readFile(path, "utf8")
      : this.#fs.readFile(path);
  }

  exists(path: string): Promise<boolean> {
    return this.statOrNull(path).then((stat) => stat !== null);
  }

  stat(path: string): Promise<WorkspaceStatResult> {
    return this.#fs.stat(path);
  }

  statOrNull(path: string): Promise<WorkspaceStatResult | null> {
    return this.#fs.stat(path).catch(() => null);
  }

  lstat(path: string): Promise<WorkspaceStatResult> {
    return this.#fs.lstat(path);
  }

  lstatOrNull(path: string): Promise<WorkspaceStatResult | null> {
    return this.#fs.lstat(path).catch(() => null);
  }

  readdir(path: string): Promise<WorkspaceDirentResult[]> {
    return this.#fs.readdir(path);
  }

  find(directory: string, pattern?: string): Promise<WorkspaceFoundEntry[]> {
    return this.#fs.find(directory, pattern);
  }

  ls(prefix: string): Promise<string[]> {
    return this.#fs.ls(prefix);
  }

  grep(
    pattern: string,
    path: string,
    options?: GrepOptions,
  ): Promise<WorkspaceGrepMatch[]> {
    return this.#fs.grep(pattern, path, options);
  }

  readlink(path: string): Promise<string> {
    return this.#fs.readlink(path);
  }

  writeFile(path: string, content: string | Uint8Array): Promise<void> {
    return this.#fs.writeFile(path, content);
  }

  mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    return this.#fs.mkdir(path, options);
  }

  rm(path: string, options?: { recursive?: boolean }): Promise<void> {
    return this.#fs.rm(path, options);
  }

  chmod(path: string, mode: number): Promise<void> {
    return this.#fs.chmod(path, mode);
  }

  symlink(target: string, path: string): Promise<void> {
    return this.#fs.symlink(target, path);
  }
}
