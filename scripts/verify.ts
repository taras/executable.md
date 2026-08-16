/**
 * Run the whole applicable verification battery at once.
 *
 * Usage (through the task, which puts the preflight in front):
 *   deno task verify
 *   deno task verify --no-site
 *
 * This file is the Deno half. `scripts/lib/verify.ts` decides what runs, in
 * what order it reports, and whether the tracked tree moved; everything that
 * touches this host — starting a process, spooling its bytes, reading the
 * index, digesting a file — is installed from here.
 *
 * ## Why each command gets a file
 *
 * `@effectionx/process` writes a child's stdout and stderr to *this* process as
 * they arrive, so ten concurrent commands would interleave into one terminal.
 * Middleware that never calls `next` suppresses that default, and the bytes go
 * to a spool of the command's own instead — raw, undecoded, one synchronous
 * handle each.
 *
 * The sink is synchronous, and that is load-bearing rather than stylistic.
 * `@effectionx/node`'s `fromReadable` subscribes with `target.on("data", …)`,
 * which puts the child's pipe in flowing mode: it is drained as fast as the
 * operating system delivers, into a queue, whether or not this process keeps
 * up. Nothing here can push back on the child, so the only thing that keeps
 * output whole is a consumer that never falls behind.
 *
 * A sink that suspends does fall behind, and loses. Holding one mid-chunk while
 * the child exited showed the pump halted at teardown with its backlog still
 * queued and those bytes gone. A synchronous write cannot be halted part way,
 * so every chunk the pump hands over is on disk before the next one arrives —
 * which is why `Spool.write` is an operation that never yields.
 *
 * ## Why the exec sits in its own scope
 *
 * `join()` settles on the child's `close` event, which does not prove the pumps
 * feeding the middleware have drained. The scope's teardown does:
 * `createPosixProcess` registers an `ensure` that signals the process group and
 * then waits on both `stdoutDone` and `stderrDone`. Closing the handle after
 * that scope exits is therefore closing it after the last byte.
 */

import { createContext, ensure, exit, main, scoped, sleep, until } from "effection";
import type { Context, Operation } from "effection";
import { lstat, rm } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import type { Stats } from "node:fs";
import { readFile, readlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { digest, FileReads, YIELD_EVERY } from "./lib/prepared-state.ts";
import type { ReadFile } from "./lib/prepared-state.ts";
import { parseStageRecords, UnsupportedEntryError } from "./lib/tracked.ts";
import type { TrackedEntry, TrackedState } from "./lib/tracked.ts";
import { useTempDirectory } from "./lib/temp-directory.ts";
import { verify } from "./lib/verify.ts";
import type { CommandSpec, Settled, VerifyHost, VerifyOptions } from "./lib/verify.ts";

const repoRoot = new URL("../", import.meta.url);
const root = fileURLToPath(repoRoot);

/** A spool this invocation owns; the UUID is what keeps two verifies apart. */
function spoolPath(directory: string, id: string): string {
  return join(directory, `${id.replaceAll(":", "-")}.${crypto.randomUUID()}.spool`);
}

export interface Spool {
  path: string;
  /**
   * Take these bytes, without suspending.
   *
   * It is an operation so the middleware can call it, not so it can wait: a
   * sink that yields here can be halted mid-chunk with a backlog queued behind
   * it, and those bytes are lost.
   */
  write(bytes: Uint8Array): Operation<void>;
  close(): void;
}

export type OpenSpool = (path: string) => Spool;

/**
 * One handle, written through a partial-write loop.
 *
 * `writeSync` may accept fewer bytes than it was given; looping until the
 * subarray is empty is what makes the spool the child's bytes rather than most
 * of them.
 */
export const openSpool: OpenSpool = (path) => {
  // Synchronous on purpose: a sink that suspends can be halted mid-chunk with
  // the pump's backlog queued behind it, and those bytes never reach the
  // spool. `the synchronous sink` in scripts/tests/verify-adapter.test.ts is
  // what keeps this handle from becoming an asynchronous one.
  // oxlint-disable-next-line local/no-sync-filesystem
  const file = Deno.openSync(path, { create: true, write: true, truncate: true });
  let open = true;
  return {
    path,
    *write(bytes) {
      let written = 0;
      while (written < bytes.length) {
        // Part of the same sink: the loop runs to completion in one turn, so
        // the pump's next chunk cannot arrive while a partial write is
        // outstanding and no backlog can be dropped at a halt.
        // oxlint-disable-next-line local/no-sync-filesystem
        written += file.writeSync(bytes.subarray(written));
      }
    },
    close() {
      if (open) {
        open = false;
        file.close();
      }
    },
  };
};

/** The seam a test substitutes to watch what the middleware hands over. */
export const SpoolSinks: Context<OpenSpool> = createContext<OpenSpool>(
  "verify.spool-sinks",
  openSpool,
);

/**
 * One synchronous write of raw bytes, returning how many it accepted.
 *
 * The report promises a failure's output *complete*, and a single `writeSync`
 * does not: it may accept fewer bytes than it was handed, and the rest are gone
 * with no error to notice. `HostOptions.write` is the seam a regression
 * substitutes to hand back short counts on purpose; `emit` is synchronous, so
 * this is an option rather than a context.
 */
export type WriteBytes = (bytes: Uint8Array) => number;

/**
 * Every byte, or an error naming the sink that stopped taking them.
 *
 * A writer that accepts nothing would spin here forever, and an unbounded loop
 * over a stalled sink is the same silent hang the battery's deadline exists to
 * remove — so zero progress raises instead.
 */
export function emitAll(write: WriteBytes, bytes: Uint8Array): void {
  let written = 0;
  while (written < bytes.length) {
    const taken = write(bytes.subarray(written));
    if (taken <= 0) {
      throw new Error(`raw output stopped accepting bytes after ${written} of ${bytes.length}`);
    }
    written += taken;
  }
}

function programPath(program: CommandSpec["program"]): string {
  if (program === "deno") {
    return Deno.execPath();
  }
  return program;
}

/**
 * `pnpm`, `tsx`, and `bun` are resolved through the workspace's own bin
 * directory: this process runs under Deno, which does not put it on the path
 * the way an npm script would.
 */
function environment(at: string): Record<string, string> {
  const path = Deno.env.get("PATH") ?? "";
  return { ...Deno.env.toObject(), PATH: `${join(at, "node_modules", ".bin")}:${path}` };
}

function* capture(command: string, args: string[], cwd: string): Operation<string> {
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  return yield* scoped(function* () {
    const process = yield* exec(command, { arguments: args, cwd, env: environment(cwd) });
    yield* process.around({
      *stdout([bytes]) {
        chunks.push(decoder.decode(bytes, { stream: true }));
      },
      *stderr() {},
    });
    const status = yield* process.join();
    if (status.code !== 0) {
      throw new Error(`\`${command} ${args.join(" ")}\` exited ${status.code}`);
    }
    return chunks.join("");
  });
}

/** A missing entry, as `node:fs` reports one. */
function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function* describeEntry(at: string, path: string, read: ReadFile): Operation<TrackedEntry> {
  const absolute = join(at, path);
  let info: Stats;
  try {
    info = yield* lstat(absolute);
  } catch (error) {
    if (isNotFound(error)) {
      return { kind: "absent" };
    }
    throw error;
  }
  if (info.isDirectory()) {
    throw new UnsupportedEntryError(
      `${path} is a directory, which this fingerprint cannot describe`,
    );
  }
  if (info.isSymbolicLink()) {
    return { kind: "symlink", target: yield* until(readlink(absolute)) };
  }
  return {
    kind: "file",
    digest: digest(yield* read(absolute)),
    executable: ((info.mode ?? 0) & 0o111) !== 0,
  };
}

/**
 * Every descendant of `pid`, deepest first, from one `ps` snapshot.
 *
 * Signalling the command's own process group is not enough. `@effectionx/process`
 * starts each `exec` in a *new* group, so a command that itself execs something
 * — `deno task test` reaching `deno bundle`, which is how the wedge arrives —
 * puts that grandchild in a group of its own, which the outer group's signal
 * never reaches. Walking parentage covers what group membership misses.
 *
 * The snapshot has to be taken while the command is still alive: once it is
 * gone its children are reparented to init and the chain that identifies them
 * as ours is gone with it.
 */
export function descendants(pid: number, snapshot: string): number[] {
  const children = new Map<number, number[]>();
  for (const line of snapshot.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(child) || !Number.isInteger(parent)) {
      continue;
    }
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }

  const found: number[] = [];
  function walk(from: number): void {
    for (const child of children.get(from) ?? []) {
      walk(child);
      found.push(child);
    }
  }
  walk(pid);
  return found;
}

function processTable(): string {
  const listed = new Deno.Command("ps", { args: ["-A", "-o", "pid=,ppid="] }).outputSync();
  return new TextDecoder().decode(listed.stdout);
}

/** Signal what the group signal missed. A process already gone is the goal, not an error. */
function reap(pids: number[]): void {
  for (const pid of pids) {
    try {
      Deno.kill(pid, "SIGTERM");
    } catch {
      // Already exited, or never ours to signal.
    }
  }
}

export interface HostOptions {
  /** Where spools live; one directory per invocation. */
  spools: string;
  /** The worktree being verified. */
  root: string;
  log(line: string): void;
  /** Raw byte sink; standard output when absent. */
  write?: WriteBytes;
}

/**
 * A host that owns its spool directory.
 *
 * Cleanup belongs to the invocation rather than to each command: the report
 * reads a failed command's spool after every command has settled, so a spool
 * removed the moment its command ended would take the output with it. The
 * directory goes when the invocation does — on success, on failure, and on a
 * halt part way through.
 */
export function* useVerifyHost(options: HostOptions): Operation<VerifyHost> {
  yield* ensure(() => rm(options.spools, { recursive: true }));
  return host(options);
}

export function host(options: HostOptions): VerifyHost {
  const { spools, root: at, log } = options;
  const paths = new Map<string, string>();

  return {
    *run(command: CommandSpec): Operation<Settled> {
      const open = yield* SpoolSinks.expect();
      const spool = open(spoolPath(spools, command.id));
      paths.set(command.id, spool.path);
      yield* ensure(() => spool.close());

      const started = performance.now();
      const status = yield* scoped(function* () {
        const process = yield* exec(programPath(command.program), {
          arguments: command.args,
          cwd: command.cwd ? join(at, command.cwd) : at,
          env: environment(at),
        });
        // Registered after the exec, so teardown runs it first — while the
        // command is still alive and its descendants are still identifiable.
        yield* ensure(() => reap(descendants(process.pid, processTable())));
        yield* process.around({
          *stdout([bytes]) {
            yield* spool.write(bytes);
          },
          *stderr([bytes]) {
            yield* spool.write(bytes);
          },
        });
        return yield* process.join();
      });
      spool.close();

      return { code: status.code ?? 1, milliseconds: performance.now() - started };
    },

    *spool(id: string): Operation<Uint8Array> {
      const path = paths.get(id);
      if (!path) {
        return new Uint8Array();
      }
      return yield* until(readFile(path));
    },

    *fingerprint(): Operation<TrackedState> {
      const read = yield* FileReads.expect();
      const records = parseStageRecords(yield* capture("git", ["ls-files", "--stage", "-z"], at));
      const entries = new Map<string, TrackedEntry>();
      for (const [index, record] of records.entries()) {
        entries.set(record.path, yield* describeEntry(at, record.path, read));
        if (index % YIELD_EVERY === YIELD_EVERY - 1) {
          yield* sleep(0);
        }
      }
      return entries;
    },

    git: (args) => capture("git", args, at),
    log,
    emit(bytes) {
      // The report's own bytes, written where the process is about to exit:
      // suspending here can lose a failed command's output to the exit that
      // follows it.
      // oxlint-disable-next-line local/no-sync-filesystem
      emitAll(options.write ?? ((chunk) => Deno.stdout.writeSync(chunk)), bytes);
    },
  };
}

export function* runVerify(args: string[]): Operation<number> {
  const options: VerifyOptions = { site: args.includes("--no-site") ? "off" : "auto" };
  for (const argument of args) {
    if (argument !== "--no-site") {
      console.error(`unknown argument \`${argument}\``);
      return 1;
    }
  }

  const spools = yield* useTempDirectory("xmd-verify-");
  const target = yield* useVerifyHost({
    spools,
    root,
    log: (message) => console.log(message),
  });

  try {
    return yield* verify(target, options);
  } catch (error) {
    // An entry the fingerprint cannot describe is a refusal, not a crash: the
    // path is the whole message, and a stack trace would bury it.
    if (error instanceof UnsupportedEntryError) {
      console.error(`✗ ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (import.meta.main) {
  main(function* (args): Operation<void> {
    const code = yield* runVerify(args);
    if (code !== 0) {
      yield* exit(code);
    }
  });
}
