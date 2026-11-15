import { copyFile, ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { exec, Stdio } from "@effectionx/process";
import { ensure, main, scoped, until } from "effection";
import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPinnedWorktree } from "./lib/run.ts";
import { compareTypingRuns } from "./lib/typing-latency-report.ts";

const TEST = "tests/mounted-typing.test.ts";
const STAGED_TEST = "tests/mounted-typing.ts";
const REPORT = "lib/typing-latency-report.ts";

function* measure(checkout: string) {
  return yield* scoped(function* () {
    yield* Stdio.around(
      {
        // deno-lint-ignore require-yield
        *stdout() {
          return;
        },
      },
      { at: "min" },
    );
    const revision = (yield* exec("git", {
      cwd: checkout,
      arguments: ["rev-parse", "--verify", "HEAD"],
    }).expect()).stdout.trim();
    yield* assertPinnedWorktree(checkout, revision);

    // Keep the same import depth as examples/repl-bench in both worktrees.
    const scratch = join(checkout, ".bench", `typing-${crypto.randomUUID()}`);
    yield* ensure(() => rm(scratch, { recursive: true, force: true }));
    for (const [file, local] of [
      [TEST, STAGED_TEST],
      [REPORT, REPORT],
    ]) {
      const staged = join(scratch, local);
      yield* ensureDir(dirname(staged));
      yield* copyFile(fileURLToPath(new URL(file, import.meta.url)), staged);
    }
    const result = yield* exec(Deno.execPath(), {
      cwd: checkout,
      env: { ...Deno.env.toObject(), XMD_TYPING_BENCH_REVISION: revision },
      arguments: [
        "test",
        "--allow-all",
        "--cached-only",
        "--frozen",
        "--node-modules-dir=none",
        "--no-check",
        join(scratch, STAGED_TEST),
      ],
    }).expect();
    yield* assertPinnedWorktree(checkout, revision);
    return { revision, stdout: result.stdout };
  });
}

if (import.meta.main) {
  main(function* ([baselinePath, candidatePath, reportPath]) {
    if (baselinePath === undefined || candidatePath === undefined || reportPath === undefined) {
      throw new Error(
        "Usage: typing-latency.ts <baseline worktree> <candidate worktree> <report.json>",
      );
    }
    const baseline = yield* until(realpath(baselinePath));
    const candidate = yield* until(realpath(candidatePath));
    if (baseline === candidate) {
      throw new Error("Supply two separate prepared worktrees.");
    }
    const before = yield* measure(baseline);
    const after = yield* measure(candidate);
    const report = compareTypingRuns(before, after);
    yield* ensureDir(dirname(resolve(reportPath)));
    yield* writeTextFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    console.log(`Mounted REPL typing at ${report.viewport.columns}×${report.viewport.rows}`);
    console.log(`Baseline \`${before.revision}\` and candidate \`${after.revision}\`\n`);
    console.log(
      "| Workload | Baseline median / p95 | Candidate median / p95 | Delta median / p95 |",
    );
    console.log("| --- | ---: | ---: | ---: |");
    for (const { workload, baseline, candidate, deltaMs } of report.workloads) {
      console.log(
        `| ${workload.name} · ${workload.rounds} rounds | ${baseline.medianMs.toFixed(2)} / ${baseline.p95Ms.toFixed(2)} ms | ` +
          `${candidate.medianMs.toFixed(2)} / ${candidate.p95Ms.toFixed(2)} ms | ${deltaMs.median.toFixed(2)} / ${deltaMs.p95.toFixed(2)} ms |`,
      );
    }
  });
}
