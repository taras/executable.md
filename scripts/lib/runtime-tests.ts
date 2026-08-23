/**
 * Running this repository's test corpus under one runtime — whole, or one
 * shard of it.
 *
 * A shard job is told a runtime and an index out of a count, and nothing else.
 * Everything it runs follows from those, the committed weights, and discovery,
 * so two jobs on two runners compute the same split or a file runs twice.
 *
 * Inside a shard the files run one at a time, in sorted order, each in its own
 * process. A failure does not stop the ones after it: a shard that abandoned
 * its remaining files would report one defect and hide the rest, and the point
 * of running the corpus is to learn what is broken. The first failure is what
 * the shard exits with.
 */
import { exit } from "effection";
import type { Context, Operation } from "effection";
import { createContext } from "effection";
import { exec } from "@effectionx/process";
import { exists, readTextFile } from "@effectionx/fs";
import { fileURLToPath } from "node:url";

import { applicableTestFiles } from "./test-files.ts";
import { testShard } from "./test-shards.ts";
import type { Shard } from "./test-shards.ts";
import { parseTestWeights, weightsFile } from "./test-weights.ts";
import { exclusions, parseRuntime, RUNTIMES } from "../runtime-test-exclusions.ts";
import type { Runtime } from "../runtime-test-exclusions.ts";

interface Runner {
  command: string;
  prefix: string[];
  /**
   * Flags that only mean anything when the runner could otherwise run more than
   * one file at a time. They belong to the one-file command, not to the corpus
   * one, so adding them here does not slow the whole-corpus invocation down.
   */
  serial: string[];
}

/** A program and its exact argument vector. */
export interface Launch {
  command: string;
  arguments: string[];
}

/**
 * Bun caps each test at 5s by default, which Deno and Node do not. Suites that
 * spawn a CLI or a worker carry their own timeboxes up to 180s, and the cap
 * preempts them — so it is raised past the longest, leaving each suite's own
 * timeout in charge.
 */
const BUN_TEST_TIMEOUT_MS = 300_000;

export const RUNNERS: Record<Runtime, Runner> = {
  deno: { command: "deno", prefix: ["test", "--allow-all", "--frozen"], serial: [] },
  node: {
    command: "tsx",
    prefix: ["--tsconfig", "tsconfig.node.json", "--test"],
    // Node's test runner spreads files across a worker per core by default, so
    // one file at a time is a property of the command rather than of how many
    // paths it was handed.
    serial: ["--test-concurrency=1"],
  },
  bun: { command: "bun", prefix: ["test", `--timeout=${BUN_TEST_TIMEOUT_MS}`], serial: [] },
};

/**
 * The exact command that runs one test file alone under `runtime`.
 *
 * Weight measurement times this command, and a shard invokes it once per
 * assigned file — so the millisecond a weight records is the millisecond that
 * shard will spend, rather than a fraction of some larger invocation.
 */
export function oneFileCommand(runtime: Runtime, file: string): Launch {
  const runner = RUNNERS[runtime];
  return {
    command: runner.command,
    arguments: [...runner.prefix, ...runner.serial, file],
  };
}

/**
 * A child killed by a signal reports no numeric code, and reporting success
 * for it would let a crashed runner pass CI.
 */
export function exitCode(status: { code?: number | null }): number {
  return status.code ?? 1;
}

/** Runs one test file and settles with its exit status. */
export type RunLaunch = (launch: Launch & { cwd: string }) => Operation<number>;

/**
 * The seam a measurement and a shard both run through. The default spawns the
 * real runner and streams its output to this process's own; a test substitutes
 * one that records what it was asked to run.
 *
 * `exec` puts each child in its own process group and owns it for the lifetime
 * of the operation, so halting a shard halts the file it is running rather than
 * orphaning it.
 */
export const TestRuns: Context<RunLaunch> = createContext<RunLaunch>(
  "runtime-tests.runs",
  function* (launch) {
    return exitCode(
      yield* exec(launch.command, { arguments: launch.arguments, cwd: launch.cwd }).join(),
    );
  },
);

/** Run `file` alone under `runtime`, from `root`. */
export function* runOneFile(runtime: Runtime, file: string, root: URL): Operation<number> {
  const run = yield* TestRuns.expect();
  return yield* run({ ...oneFileCommand(runtime, file), cwd: fileURLToPath(root) });
}

/** Which shard of how many, as a matrix job spells it. */
export interface ShardSelection {
  index: number;
  count: number;
}

/**
 * `<index>/<count>`, or `undefined` when it is not that.
 *
 * Deliberately strict: only digits, and only in that shape. A selection that
 * parsed loosely would let `3/` or `03/6` name a shard nobody assigned.
 */
export function parseShardSelection(value: string): ShardSelection | undefined {
  const matched = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value);
  if (matched === null) {
    return undefined;
  }
  const index = Number(matched[1]);
  const count = Number(matched[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count)) {
    return undefined;
  }
  return { index, count };
}

export interface ShardOutcome {
  /** Every file this shard actually invoked, in the order it invoked them. */
  ran: string[];
  /** The first file that did not succeed, and what it exited with. */
  failure?: { file: string; status: number };
}

/**
 * Invoke each of `files` alone, in order, and report what happened.
 *
 * Native output is not captured, transformed, or summarized here — the child
 * writes to this process's own streams, so a failure's complete text reaches
 * the log exactly as the runner produced it.
 */
export function* runShardFiles(
  runtime: Runtime,
  files: string[],
  root: URL,
): Operation<ShardOutcome> {
  const ran: string[] = [];
  let failure: { file: string; status: number } | undefined;

  for (const file of files) {
    ran.push(file);
    const status = yield* runOneFile(runtime, file, root);
    if (status !== 0 && failure === undefined) {
      failure = { file, status };
    }
  }

  return { ran, failure };
}

/** What a shard prints before it invokes its first file. */
export function describeShard(runtime: Runtime, shard: Shard): string {
  return [
    `${runtime} shard ${shard.index}/${shard.count}: ${shard.files.length} files, ${shard.weight}ms predicted`,
    ...shard.files.map((file) => `  ${file}`),
    ...shard.unmeasured.map(
      (file) => `  unmeasured, charged the heaviest recorded weight: ${file}`,
    ),
  ].join("\n");
}

const USAGE = `usage: runtime-tests.ts <${RUNTIMES.join("|")}> [<index>/<count>]`;

/** The applicable corpus and the recorded weights, resolved into one shard. */
function* selectShard(runtime: Runtime, root: URL, selection: ShardSelection): Operation<Shard> {
  const files = yield* applicableTestFiles(runtime, root);
  const path = weightsFile(root);

  // Named before it is read: a shard cannot be assigned without weights, and
  // "ENOENT" does not tell an operator that the answer is a dispatched
  // measurement rather than a missing checkout.
  if (!(yield* exists(path))) {
    throw new Error(
      `${fileURLToPath(path)} is missing; dispatch the "Measure test weights" workflow against this ref and commit the artifact it uploads`,
    );
  }

  const weights = parseTestWeights(yield* readTextFile(path));
  return testShard(files, weights.runtimes[runtime], selection.index, selection.count);
}

/**
 * Run `runtime`'s tests and exit with what they reported.
 *
 * With no selection this is the whole applicable corpus in one invocation,
 * which is what a human debugging the suite wants and what `test:node` and
 * `test:bun` have always done. With one, it is that shard, file by file.
 */
export function* runtimeTests(
  runtime: string,
  selection: string | undefined,
  root: URL,
): Operation<void> {
  const selected = parseRuntime(runtime);
  if (selected === undefined) {
    console.error(USAGE);
    yield* exit(1);
    return;
  }

  if (selection === undefined) {
    const files = yield* applicableTestFiles(selected, root);

    // The gap belongs in the log: a silent exclusion reads as full coverage.
    for (const entry of exclusions[selected]) {
      console.error(
        `excluded from ${selected}: ${entry.path}\n  ${entry.reason}\n  ${entry.issue}`,
      );
    }
    console.error(`running ${files.length} test files under ${selected}`);

    const runner = RUNNERS[selected];
    const status = yield* exec(runner.command, {
      arguments: [...runner.prefix, ...files],
      cwd: fileURLToPath(root),
    }).join();
    yield* exit(exitCode(status));
    return;
  }

  const parsed = parseShardSelection(selection);
  if (parsed === undefined) {
    console.error(USAGE);
    yield* exit(1);
    return;
  }

  // Resolved before a single process is spawned, so an index nobody assigned,
  // a count out of range, or unreadable weights cost a message rather than a
  // partial run that looks like a pass.
  let shard: Shard;
  try {
    shard = yield* selectShard(selected, root, parsed);
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : error}`);
    yield* exit(1);
    return;
  }

  console.error(describeShard(selected, shard));

  const outcome = yield* runShardFiles(selected, shard.files, root);
  const ran = `${selected} shard ${shard.index}/${shard.count}: ${outcome.ran.length} of ${shard.files.length} files ran`;

  if (outcome.failure === undefined) {
    console.error(`${ran}, all passed`);
    yield* exit(0);
    return;
  }

  console.error(`${ran}; first failure ${outcome.failure.file} exited ${outcome.failure.status}`);
  yield* exit(outcome.failure.status);
}
