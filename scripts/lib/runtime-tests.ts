import { exit } from "effection";
import type { Operation } from "effection";
import { exec } from "@effectionx/process";
import { listTestFiles } from "./test-files.ts";
import { exclusions } from "../runtime-test-exclusions.ts";

interface Runner {
  command: string;
  prefix: string[];
}

export const RUNNERS: Record<string, Runner> = {
  node: { command: "tsx", prefix: ["--tsconfig", "tsconfig.node.json", "--test"] },
  bun: { command: "bun", prefix: ["test"] },
};

/**
 * A child killed by a signal reports no numeric code, and reporting success
 * for it would let a crashed runner pass CI.
 */
export function exitCode(status: { code?: number | null }): number {
  return status.code ?? 1;
}

/**
 * Run every discovered test file under `runtime`, minus that runtime's
 * exclusions, and exit with the runner's own status.
 */
export function* runtimeTests(runtime: string, root: URL): Operation<void> {
  const runner = RUNNERS[runtime];
  if (!runner) {
    console.error(`usage: runtime-tests.ts <${Object.keys(RUNNERS).join("|")}>`);
    yield* exit(1);
    return;
  }

  const excluded = exclusions[runtime] ?? [];
  const skip = new Set(excluded.map((entry) => entry.path));
  const files = (yield* listTestFiles(root)).filter((file) => !skip.has(file));

  // The gap belongs in the log: a silent exclusion reads as full coverage.
  for (const entry of excluded) {
    console.error(`excluded from ${runtime}: ${entry.path}\n  ${entry.reason}\n  ${entry.issue}`);
  }
  console.error(`running ${files.length} test files under ${runtime}`);

  const status = yield* exec(runner.command, {
    arguments: [...runner.prefix, ...files],
  }).join();
  yield* exit(exitCode(status));
}
