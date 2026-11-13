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
 *
 * A Markdown suite runs through the `xmd test` entrypoint of the same runtime,
 * so a shard, a measurement and a local run all launch it the same way.
 */
import { exit, until } from "effection";
import type { Context, Operation } from "effection";
import { createContext } from "effection";
import { exec } from "@effectionx/process";
import { exists, readTextFile } from "@effectionx/fs";
import { launchEnvironment, shellQuote } from "@executablemd/test-support/launch";
import { readlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { applicableTestFiles, isMarkdownSuite } from "./test-files.ts";
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

/** A program, its exact argument vector, and the environment it replaces this process's with. */
export interface Launch {
  command: string;
  arguments: string[];
  /** Absent for a TypeScript runner, which inherits this process's environment. */
  env?: Record<string, string>;
}

/** The checkout this runner belongs to, which supplies every CLI entrypoint it launches. */
const CHECKOUT = new URL("../../", import.meta.url);

function checkoutPath(path: string): string {
  return fileURLToPath(new URL(path, CHECKOUT));
}

/**
 * The prepared Deno CLI. Fixture documents run their real workflow under it
 * whichever runtime runs the suite, because the run profile they exercise is
 * the Deno host's.
 */
function denoCli(): string[] {
  return [
    "deno",
    "run",
    "--quiet",
    "--allow-all",
    "--node-modules-dir=manual",
    "--cached-only",
    "--frozen",
    checkoutPath("packages/cli/src/deno.ts"),
  ];
}

function cliEntry(runtime: Runtime): string[] {
  if (runtime === "deno") {
    return denoCli();
  }
  if (runtime === "node") {
    return [
      "tsx",
      "--tsconfig",
      checkoutPath("tsconfig.node.json"),
      checkoutPath("packages/cli/src/node.ts"),
    ];
  }
  return ["bun", checkoutPath("packages/cli/src/bun.ts")];
}

/**
 * `xmd test <file>` under `runtime`, with the fixture plugin, the example's
 * component directories as absolute paths — so a nested `<Dir>` cannot move
 * where components are found — and only the environment a launched CLI gets.
 */
function markdownCommand(runtime: Runtime, file: string, root: URL): Launch {
  const [command, ...entry] = cliEntry(runtime);
  const example = (path: string) =>
    fileURLToPath(new URL(`examples/adversarial-implementation/${path}`, root));
  const fixture = (subcommand: string[]) => [...denoCli(), ...subcommand].map(shellQuote).join(" ");
  return {
    command,
    arguments: [
      ...entry,
      "test",
      file,
      "--plugin",
      checkoutPath("packages/cli/tests/fixtures/workflow-test-permissions.mjs"),
      "--include",
      example("tests/components"),
      "--include",
      example("components"),
    ],
    env: launchEnvironment({
      XMD_EXAMPLE_COMMAND: fixture(["run", "--allow-absolute"]),
      XMD_EXAMPLE_TEST_COMMAND: fixture(["test"]),
    }),
  };
}

/**
 * Bun caps each test at 5s by default, which Deno and Node do not. Suites that
 * spawn a CLI or a worker need a larger base cap. oneFileCommand also raises
 * it for Preparation's enclosing deadline, leaving that suite's own timeout
 * in charge.
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
export function oneFileCommand(runtime: Runtime, file: string, root: URL = CHECKOUT): Launch {
  if (isMarkdownSuite(file)) {
    return markdownCommand(runtime, file, root);
  }
  const runner = RUNNERS[runtime];
  const prefix =
    runtime === "bun" && file === "packages/cli/tests/adversarial-preparation.test.ts"
      ? ["test", "--timeout=450000"]
      : runner.prefix;
  return {
    command: runner.command,
    arguments: [...prefix, ...runner.serial, file],
  };
}

/**
 * A child killed by a signal reports no numeric code, and reporting success
 * for it would let a crashed runner pass CI.
 */
export function exitCode(status: { code?: number | null }): number {
  return status.code ?? 1;
}

/** Runs one launch — a test file, or a native batch of them — and settles with its exit status. */
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
  spawnLaunch,
);

/** The real runner `TestRuns` defaults to, for a test that adjusts a launch before running it. */
export function* spawnLaunch(launch: Launch & { cwd: string }): Operation<number> {
  return exitCode(
    yield* exec(launch.command, {
      arguments: launch.arguments,
      cwd: launch.cwd,
      env: launch.env,
    }).join(),
  );
}

/**
 * The prepared dependency link a Markdown suite must leave as it found it. Its
 * fixtures run nested Deno commands against the same checkout, and one that
 * relinked `node_modules` would change what every later file imports.
 */
export const PREPARED_LINK = "node_modules/effection";

function* preparedLink(root: URL): Operation<string | undefined> {
  try {
    return yield* until(readlink(fileURLToPath(new URL(PREPARED_LINK, root))));
  } catch {
    return undefined;
  }
}

/**
 * Run `file` alone under `runtime`, from `root`.
 *
 * A Markdown suite is also held to the prepared dependency link it started
 * with. A changed or missing link fails the file even when its own tests
 * passed; a file that already failed keeps its own status.
 */
export function* runOneFile(runtime: Runtime, file: string, root: URL): Operation<number> {
  const run = yield* TestRuns.expect();
  const launch = { ...oneFileCommand(runtime, file, root), cwd: fileURLToPath(root) };
  if (!isMarkdownSuite(file)) {
    return yield* run(launch);
  }
  const before = yield* preparedLink(root);
  const status = yield* run(launch);
  const after = yield* preparedLink(root);
  if (after === before) {
    return status;
  }
  console.error(
    `${file} changed the prepared dependency link ${PREPARED_LINK}: ${before ?? "absent"} -> ${after ?? "absent"}`,
  );
  return status === 0 ? 1 : status;
}

/** `current` unless it succeeded, so the earliest failure is the one kept. */
function firstFailure(current: number, next: number): number {
  return current === 0 ? next : current;
}

/**
 * The whole applicable corpus under `runtime`: every TypeScript file in one
 * native invocation, then each Markdown suite alone. The first failure is the
 * status; a failure in one portion does not skip the other.
 */
export function* runSuite(runtime: Runtime, root: URL): Operation<number> {
  const files = yield* applicableTestFiles(runtime, root);
  const typescript = files.filter((file) => !isMarkdownSuite(file));
  const run = yield* TestRuns.expect();
  const runner = RUNNERS[runtime];
  let status =
    typescript.length === 0
      ? 0
      : yield* run({
          command: runner.command,
          arguments: [...runner.prefix, ...typescript],
          cwd: fileURLToPath(root),
        });
  for (const file of files.filter(isMarkdownSuite)) {
    status = firstFailure(status, yield* runOneFile(runtime, file, root));
  }
  return status;
}

/**
 * `deno task test`. With no arguments it is Deno's own whole-repository run —
 * including the files the CI corpus leaves to smoke jobs — followed by every
 * applicable Markdown suite. Arguments go to `deno test` verbatim, so focused
 * paths, `--changed` and `--related` keep their native meaning; the Markdown
 * graph is invisible to those flags, so a Markdown suite is selected by naming
 * its path, beside any TypeScript paths, and never beside a flag.
 */
export function* localDenoTests(args: string[], root: URL): Operation<number> {
  const run = yield* TestRuns.expect();
  const native = (selected: string[]) =>
    run({
      command: RUNNERS.deno.command,
      arguments: [...RUNNERS.deno.prefix, ...selected],
      cwd: fileURLToPath(root),
    });
  const markdown = args.filter((arg) => arg.endsWith(".md")).map((arg) => arg.replace(/^\.\//, ""));

  if (args.length === 0) {
    let status = yield* native([]);
    for (const file of (yield* applicableTestFiles("deno", root)).filter(isMarkdownSuite)) {
      status = firstFailure(status, yield* runOneFile("deno", file, root));
    }
    return status;
  }
  if (markdown.length === 0) {
    return yield* native(args);
  }

  const flags = args.filter((arg) => arg.startsWith("-"));
  if (flags.length > 0) {
    console.error(
      `a Markdown suite is selected by its path alone; remove ${flags.join(" ")} or run the Markdown paths separately`,
    );
    return 1;
  }
  const suites = new Set((yield* applicableTestFiles("deno", root)).filter(isMarkdownSuite));
  const unknown = markdown.filter((file) => !suites.has(file));
  if (unknown.length > 0) {
    console.error(`not a Markdown suite under deno: ${unknown.join(" ")}`);
    return 1;
  }

  const typescript = args.filter((arg) => !arg.endsWith(".md"));
  let status = typescript.length === 0 ? 0 : yield* native(typescript);
  for (const file of markdown) {
    status = firstFailure(status, yield* runOneFile("deno", file, root));
  }
  return status;
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
 * With no selection this is the whole applicable corpus — its TypeScript in one
 * native invocation, which is what a human debugging the suite wants and what
 * `test:node` and `test:bun` have always done, then each Markdown suite. With
 * one, it is that shard, file by file.
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

    yield* exit(yield* runSuite(selected, root));
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
