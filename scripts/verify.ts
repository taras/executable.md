/**
 * Run the shared-state interference proof.
 *
 * Usage (through the task, which puts the preflight in front):
 *   deno task verify
 *
 * This file is the Deno half. `scripts/lib/verify.ts` decides the topology, the
 * report's order, and whether repository-owned state moved; everything that
 * touches this host — starting a process, spooling its bytes, reading the
 * index, digesting a file, launching the three runtimes — is installed from
 * here.
 *
 * ## Why each participant gets a file
 *
 * `@effectionx/process` writes a child's stdout and stderr to *this* process as
 * they arrive, so four concurrent participants would interleave into one
 * terminal. Middleware that never calls `next` suppresses that default, and the
 * bytes go to a spool of the participant's own instead — raw, undecoded, one
 * synchronous handle each.
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
 *
 * The consumers are launched from here for the same reason. Their loop is
 * portable and lives in `lib/consumer-cycle.ts`; what is not portable is how
 * each runtime starts a TypeScript entry, and Node's is the prepared
 * workspace's own `tsx` rather than a global one.
 */
import { createContext, ensure, exit, main, scoped, sleep, until } from "effection";
import type { Context, Operation } from "effection";
import { exists, lstat, rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import type { Stats } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

import { digest, FileReads, hostState } from "./lib/prepared-state.ts";
import type { ReadFile } from "./lib/prepared-state.ts";
import { isNotFound, trackedState } from "./lib/tracked-fingerprint.ts";
import { UnsupportedEntryError } from "./lib/tracked.ts";
import { useTempDirectory } from "./lib/temp-directory.ts";
import { sideEffectFreeManifests } from "./lib/side-effect-free.ts";
import { incomplete } from "./lib/web-client-module.ts";
import { cyclesOf, GENERATED, readyPath, signalPath } from "./lib/consumer-cycle.ts";
import type { CycleReport, Runtime } from "./lib/consumer-cycle.ts";
import { UNREADABLE, verify } from "./lib/verify.ts";
import type { OwnedState, Sensitive, Settled, VerifyHost } from "./lib/verify.ts";

const repoRoot = new URL("../", import.meta.url);
const root = fileURLToPath(repoRoot);

/** A spool this invocation owns; the UUID is what keeps two verifies apart. */
function spoolPath(directory: string, id: string): string {
  return join(directory, `${id.replaceAll(":", "-")}.${crypto.randomUUID()}.spool`);
}

/**
 * How each runtime starts the portable consumer entry.
 *
 * Node's is the prepared workspace's own `tsx`, not a global one: the proof is
 * about *this* tree's dependency layout, and reaching a `tsx` from anywhere
 * else would be consuming something the producer cannot disturb.
 *
 * Every `deno` process the proof starts carries `--node-modules-dir=manual`.
 * Under the repository's `"auto"` mode, a bare `deno` invocation re-creates
 * the workspace's `node_modules` links before it reaches its own code — an
 * unlink followed by a symlink, which a participant resolving through the
 * link in that instant observes as the package not existing. `manual`
 * resolves through the tree exactly as it stands and manages nothing, which
 * is also the only honest posture here: the proof is that the *prepared*
 * layout holds, not that each participant can repair it on the way in.
 */
export function consumerCommand(runtime: Runtime, at: string, control: string): CommandSpec {
  const entry = "scripts/verify-consumer.ts";
  const args = [runtime, at, control];
  if (runtime === "deno") {
    return {
      id: runtime,
      program: "deno",
      args: ["run", "--allow-all", "--node-modules-dir=manual", entry, ...args],
    };
  }
  if (runtime === "node") {
    return { id: runtime, program: "tsx", args: [entry, ...args] };
  }
  return { id: runtime, program: "bun", args: ["run", entry, ...args] };
}

/**
 * The producer. The inner `build:web` already runs under modes that cannot
 * create, relink, or fetch; `--node-modules-dir=manual` extends that to the
 * task runner itself, whose own startup would otherwise re-create the
 * workspace links the consumers are resolving through.
 */
export function producerCommand(): CommandSpec {
  return {
    id: "build:web",
    program: "deno",
    args: ["task", "--node-modules-dir=manual", "build:web"],
  };
}

/** A process this host starts. Named rather than resolved. */
export interface CommandSpec {
  id: string;
  program: "deno" | "tsx" | "bun";
  args: string[];
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
 * A manifest by its bytes *and* its identity on disk.
 *
 * Content alone is not enough: a build that rewrote the file with the same
 * bytes still truncated it for as long as the write took, and every runtime
 * resolving through it in that window read a broken package. The inode and the
 * change time are what make that rewrite visible after the fact.
 */
function* manifestState(path: URL, read: ReadFile): Operation<string> {
  const file = fileURLToPath(path);
  let info: Stats;
  try {
    info = yield* lstat(file);
  } catch (error) {
    if (isNotFound(error)) {
      return "absent";
    }
    throw error;
  }
  const bytes = yield* read(file);
  return [
    digest(bytes),
    `size=${info.size}`,
    `ino=${info.ino}`,
    `mode=${(info.mode ?? 0).toString(8)}`,
    `ctime=${info.ctimeMs}`,
    `mtime=${info.mtimeMs}`,
  ].join(" ");
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
  /** Where readiness, phase signals and cycle reports live; one per invocation. */
  control: string;
  /** The worktree being proven. */
  root: string;
  log(line: string): void;
  /** Raw byte sink; standard output when absent. */
  write?: WriteBytes;
}

/**
 * A host that owns its spool and control directories.
 *
 * Cleanup belongs to the invocation rather than to each participant: the report
 * reads a failed participant's spool and every consumer's cycle report after
 * everything has settled, so state removed the moment a process ended would
 * take the evidence with it. Both directories go when the invocation does — on
 * success, on failure, and on a halt part way through. Neither has a fixed
 * name, so a concurrent invocation's state is never touched.
 */
/**
 * The adapter's own surface, which is wider than the contract it satisfies.
 *
 * `start` is how the regressions here drive a real child of their own through
 * the spooling, descendant cleanup and invocation-owned state this file is
 * responsible for. The coordinator never sees it: it is handed a `VerifyHost`,
 * whose only processes are the producer and the three consumers.
 */
export interface AdapterHost extends VerifyHost {
  start(command: CommandSpec): Operation<Settled>;
}

export function* useVerifyHost(options: HostOptions): Operation<AdapterHost> {
  yield* ensure(() => rm(options.spools, { recursive: true, force: true }));
  yield* ensure(() => rm(options.control, { recursive: true, force: true }));
  return host(options);
}

export function host(options: HostOptions): AdapterHost {
  const { spools, control, root: at, log } = options;
  const paths = new Map<string, string>();
  const manifests = sideEffectFreeManifests(pathToFileURL(`${at}/`));
  let observation = 0;

  function* start(command: CommandSpec): Operation<Settled> {
    const open = yield* SpoolSinks.expect();
    const spool = open(spoolPath(spools, command.id));
    paths.set(command.id, spool.path);
    yield* ensure(() => spool.close());

    const started = performance.now();
    const status = yield* scoped(function* () {
      const process = yield* exec(programPath(command.program), {
        arguments: command.args,
        cwd: at,
        env: environment(at),
      });
      // Registered after the exec, so teardown runs it first — while the
      // participant is still alive and its descendants are still identifiable.
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
  }

  return {
    start,

    produce: () => start(producerCommand()),

    consume: (runtime) => start(consumerCommand(runtime, at, control)),

    *spool(id: string): Operation<Uint8Array> {
      const path = paths.get(id);
      if (!path) {
        return new Uint8Array();
      }
      return yield* until(readFile(path));
    },

    isReady: (runtime) => exists(readyPath(control, runtime)),

    cycles: (runtime): Operation<CycleReport | undefined> => cyclesOf(control, runtime),

    *signal(name: string): Operation<void> {
      yield* writeTextFile(signalPath(control, name), `${name}\n`);
    },

    /**
     * Read the state a producer must not disturb, the way a reader would.
     *
     * The generated module is parsed rather than imported. This runs every few
     * milliseconds for the producer's whole lifetime, and evaluating 800 KB of
     * module text at that rate would retain a module instance per reading; the
     * three consumers do the importing, once per cycle, and check the assets
     * against their own recorded byte counts.
     */
    *sensitive(): Operation<Sensitive> {
      const read = yield* FileReads.expect();
      const found: Record<string, string> = {};
      for (const path of manifests) {
        found[fileURLToPath(path).slice(at.length + 1)] = yield* manifestState(path, read);
      }

      observation++;
      const generated = join(at, GENERATED);
      let text: string;
      try {
        text = new TextDecoder().decode(yield* read(generated));
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        return {
          manifests: found,
          generated: `${UNREADABLE}${GENERATED} could not be read — ${why}`,
        };
      }
      const wrong = incomplete(text);
      return {
        manifests: found,
        generated:
          wrong === undefined
            ? `whole at reading ${observation} (${text.length} chars)`
            : `${UNREADABLE}${wrong}`,
      };
    },

    *owned(): Operation<OwnedState> {
      const state = yield* hostState(at);
      return { tracked: yield* trackedState(at), installed: state.tree.entries, lock: state.lock };
    },

    pause: (milliseconds) => sleep(milliseconds),

    log,
    emit(bytes) {
      // The report's own bytes, written where the process is about to exit:
      // suspending here can lose a failed participant's output to the exit that
      // follows it.
      // oxlint-disable-next-line local/no-sync-filesystem
      emitAll(options.write ?? ((chunk) => Deno.stdout.writeSync(chunk)), bytes);
    },
  };
}

export function* runVerify(args: string[]): Operation<number> {
  for (const argument of args) {
    console.error(`unknown argument \`${argument}\``);
    return 1;
  }

  const spools = yield* useTempDirectory("xmd-verify-");
  const control = yield* useTempDirectory("xmd-verify-control-");
  const target = yield* useVerifyHost({
    spools,
    control,
    root,
    log: (message) => console.log(message),
  });

  try {
    return yield* verify(target);
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
