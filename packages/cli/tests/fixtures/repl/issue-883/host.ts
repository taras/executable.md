/**
 * The host a Sidekick recovery case runs under, and a repository root to run in.
 *
 * `installReplHost` is the production assembly — the same call `src/deno-repl.ts`
 * and `src/node-repl.ts` make — so a case that installs this is running the
 * real storage boundary over a real directory. That matters here more than
 * anywhere else in the suite: every recovery assertion is about what survived on
 * disk, and an injected in-memory stream would be asserting the fixture's own
 * bookkeeping rather than the file's.
 *
 * Shared because the later sections need exactly this and nothing more. What a
 * case brings of its own is the interruption.
 */

import { appendFile, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensure, run, spawn, until } from "effection";
import type { Stream } from "effection";
import { exec } from "@effectionx/process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { cliRuntime } from "@executablemd/test-support/launch";
import type { Operation } from "effection";

import { installReplHost } from "../../../../src/repl-assembly.ts";
import { REPL_DIRECTORY } from "../../../../src/repl/storage.ts";

/** How a gate can hold or fail one real append, by the path it is reaching. */
export interface AppendGate {
  /** Returning an operation holds that append; throwing from it fails one. */
  hold?: (path: string, record: string) => Operation<void> | undefined;
  /** Every path an append actually reached, in order. */
  readonly reached: string[];
}

export function openGate(): AppendGate {
  return { reached: [] };
}

/**
 * One data root that outlives the scope which made it, and its repository.
 *
 * Deliberately *not* tied to a scope: a recovery case writes in one scope and
 * reads in another, and a root removed with the first scope would leave the
 * second with nothing to recover from. The case owns the removal, which is also
 * what lets it keep the directory when a row fails and go and look at it.
 *
 * `repository` is where this CLI's histories live beneath that root — the same
 * `xmd/repl` the production storage layer chooses — so a case addresses the
 * repository rather than reconstructing the path.
 */
export interface RepositoryRoot {
  /** The data root, as a runtime entrypoint would report one. */
  readonly data: string;
  /** The directory the REPL keeps its executions in. */
  readonly repository: string;
  /** Remove the whole root. The case calls this when it is finished with it. */
  discard(): Operation<void>;
}

export function* createRepositoryRoot(): Operation<RepositoryRoot> {
  const data = yield* until(mkdtemp(join(tmpdir(), "xmd-sidekick-recovery-")));
  const repository = join(data, ...REPL_DIRECTORY);
  yield* until(mkdir(repository, { recursive: true }));
  return {
    data,
    repository,
    discard(): Operation<void> {
      return until(rm(data, { recursive: true, force: true }));
    },
  };
}

/**
 * Install the production host over an existing root, for this scope only.
 *
 * The host is what a fresh process brings and the directory is what it finds,
 * so a recovery case installs this once per scope over one root it keeps. The
 * identifier is random exactly as a runtime entrypoint mints one, because what
 * an execution is called is the runtime's business.
 */
export function* useReplHostAt(
  root: RepositoryRoot,
  gate: AppendGate = openGate(),
): Operation<AppendGate> {
  yield* installReplHost({
    dataRoot: () => root.data,
    identify: () => randomBytes(8).toString("hex"),
    createExclusive: (path) => open(path, "wx").then((handle) => handle.close()),
    appendRecord: (path, record) => appendRecord(gate, path, record),
  });
  return gate;
}

/**
 * One repository root owned by the asking scope, for a case that needs only one.
 *
 * Removed when that scope ends, so a row leaving a half-published pair behind
 * cannot be what the next row reads.
 */
export function* useRepositoryRoot(gate: AppendGate = openGate()): Operation<RepositoryRoot> {
  const root = yield* createRepositoryRoot();
  yield* ensure(() => root.discard());
  yield* useReplHostAt(root, gate);
  return root;
}

/**
 * Append one record, through whatever this case's gate wants to do about it.
 *
 * The gate runs *before* the write and inside the host, so a held append is
 * genuinely in flight — the writer's own count is raised, and a handoff waiting
 * for it has something to wait for. A gate that held the caller instead would
 * prove nothing about ordering.
 */
function appendRecord(gate: AppendGate, path: string, record: string): Promise<void> {
  const holding = gate.hold?.(path, record);
  if (holding === undefined) {
    return appendFile(path, record).then(() => {
      gate.reached.push(path);
    });
  }
  // The gate is an Effection operation and this boundary is a promise, so the
  // two meet here — `run` bridges them, the same way the ACP fixtures do.
  return run(() => holding).then(() =>
    appendFile(path, record).then(() => {
      gate.reached.push(path);
    }),
  );
}

/**
 * Run one recovery phase as its own process, and read back what it reported.
 *
 * The runtime comes from `cliRuntime()` — the one place in this repository that
 * is allowed to know which host a suite is on — so the phase runs under the
 * same runtime as the suite launching it rather than under a hard-coded one.
 *
 * Synchronization is the child exiting. There is no sleep anywhere in it: a
 * phase that interrupts a publication does so from inside the production code
 * and then ends, so "the interruption has happened" and "the process is gone"
 * are the same observation.
 *
 * Only the data root and the execution name cross, as arguments. Everything
 * else the phase learns, it learns from the files.
 */
export function* runPhase(
  phase:
    | "seed"
    | "interrupt"
    | "publish"
    | "read"
    | "bytes"
    | "seed-chat"
    | "prior"
    | "reserve"
    | "admit"
    | "reconcile"
    | "chat-open"
    | "chat-say"
    | "chat-read",
  root: RepositoryRoot,
  execution: string,
  /** One further argument, for a phase that takes one. */
  extra?: string,
): Operation<Record<string, unknown>> {
  const script = fileURLToPath(new URL("./recovery-phase.ts", import.meta.url));
  const launch = phaseCommand(script, [
    phase,
    root.data,
    execution,
    ...(extra === undefined ? [] : [extra]),
  ]);
  const child = yield* exec(launch.command, {
    arguments: launch.arguments,
    env: phaseEnv(),
  });
  // Collected *while* the child runs, not after it. A subscription taken once
  // the process has already settled never settles itself, so reading the
  // streams after the join is how a phase hangs instead of reporting.
  const captured = { stdout: "", stderr: "" };
  yield* spawn(() => accumulate(child.stdout, captured, "stdout"));
  yield* spawn(() => accumulate(child.stderr, captured, "stderr"));
  const status = yield* child.join();
  if (status.code !== 0) {
    throw new Error(
      `the ${phase} phase exited ${status.code ?? "on a signal"}: ${captured.stderr}`,
    );
  }
  const line = captured.stdout.trim().split("\n").at(-1) ?? "";
  if (line.length === 0) {
    throw new Error(`the ${phase} phase reported nothing: ${captured.stderr}`);
  }
  return JSON.parse(line) as Record<string, unknown>;
}

/** How this runtime launches a TypeScript entrypoint of its own. */
function phaseCommand(
  script: string,
  args: string[],
): {
  command: string;
  arguments: string[];
} {
  switch (cliRuntime()) {
    case "deno":
      return { command: process.execPath, arguments: ["run", "--allow-all", script, ...args] };
    case "bun":
      return { command: process.execPath, arguments: [script, ...args] };
    default:
      return {
        command: "tsx",
        arguments: [
          "--tsconfig",
          fileURLToPath(new URL("../../../../../../tsconfig.node.json", import.meta.url)),
          script,
          ...args,
        ],
      };
  }
}

/**
 * What a phase needs from this process, and nothing else.
 *
 * `HOME` is deliberately absent, as it is for every other launch in this
 * repository: a phase that reached a developer's own configuration would be
 * reading something no test wrote.
 */
function phaseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "DENO_DIR", "DENO_INSTALL_ROOT", "XDG_CACHE_HOME", "TMPDIR"]) {
    const value = process.env[name];
    if (typeof value === "string") {
      env[name] = value;
    }
  }
  return env;
}

function* accumulate(
  stream: Stream<Uint8Array, unknown>,
  into: { stdout: string; stderr: string },
  channel: "stdout" | "stderr",
): Operation<void> {
  const subscription = yield* stream;
  for (let next = yield* subscription.next(); !next.done; next = yield* subscription.next()) {
    into[channel] += new TextDecoder().decode(next.value);
  }
}
