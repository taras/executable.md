import { exit } from "effection";
import type { Operation } from "effection";
import { exec } from "@effectionx/process";
import { applicableTestFiles } from "./test-files.ts";
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

/**
 * Run every test file applicable to `runtime` and exit with the runner's own
 * status.
 */
export function* runtimeTests(runtime: string, root: URL): Operation<void> {
  const selected = parseRuntime(runtime);
  if (selected === undefined) {
    console.error(`usage: runtime-tests.ts <${RUNTIMES.join("|")}>`);
    yield* exit(1);
    return;
  }

  const files = yield* applicableTestFiles(selected, root);

  // The gap belongs in the log: a silent exclusion reads as full coverage.
  for (const entry of exclusions[selected]) {
    console.error(`excluded from ${selected}: ${entry.path}\n  ${entry.reason}\n  ${entry.issue}`);
  }
  console.error(`running ${files.length} test files under ${selected}`);

  const runner = RUNNERS[selected];
  const status = yield* exec(runner.command, {
    arguments: [...runner.prefix, ...files],
  }).join();
  yield* exit(exitCode(status));
}
