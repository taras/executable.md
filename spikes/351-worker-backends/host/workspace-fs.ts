// WorkspaceFs over the in-process DOFS filesystem.
//
// Cloudflare's vendored adapter (vendor/worker-shell/adapter.ts) consumes a
// structural `WorkspaceFs` — the subset of their WorkspaceFilesystemStub the
// shell needs. Three of its methods (exists, statOrNull, lstatOrNull) live on
// the RPC stub rather than the base filesystem, because on Cloudflare a miss
// thrown across Workers RPC surfaces as an uncaught exception even when
// just-bash is deliberately probing. In-process there is no RPC, so they are
// a try/catch over the DOFS filesystem.

// @ts-types="./types/dofs.d.ts"
import { Database, WorkspaceFilesystem } from "@cloudflare/dofs";
import type {
  GrepOptions,
  WorkspaceDirentResult,
  WorkspaceFoundEntry,
  WorkspaceGrepMatch,
  WorkspaceStatResult,
} from "./types/dofs.d.ts";

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
    if (encoding === "utf8") {
      return this.#fs.readFile(path, "utf8");
    }
    return this.#fs.readFile(path);
  }

  async exists(path: string): Promise<boolean> {
    return (await this.statOrNull(path)) !== null;
  }

  stat(path: string): Promise<WorkspaceStatResult> {
    return this.#fs.stat(path);
  }

  async statOrNull(path: string): Promise<WorkspaceStatResult | null> {
    try {
      return await this.#fs.stat(path);
    } catch {
      return null;
    }
  }

  lstat(path: string): Promise<WorkspaceStatResult> {
    return this.#fs.lstat(path);
  }

  async lstatOrNull(path: string): Promise<WorkspaceStatResult | null> {
    try {
      return await this.#fs.lstat(path);
    } catch {
      return null;
    }
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
