/**
 * Executable proof for #726: persistent tmux pane workers for `<Terminal.Grid>`.
 *
 * Usage (from a prepared checkout):
 *
 *   deno task proof:tmux-pane-workers              # everything, unattended
 *   deno task proof:tmux-pane-workers -- --attach  # the journey on your terminal
 *
 * Unattended runs need a terminal for the visible attachment, so the proof
 * starts a throwaway outer tmux session of its own and runs itself inside it
 * (`--inner`); progress is relayed to stderr and the evidence — `evidence.json`,
 * `summary.md`, the children's evidence files — is written to `--out <dir>`
 * (default: a fresh directory under the system temporary directory, printed
 * at the end). `--runs N` sets the measurement runs per pane count (default
 * 20); `--skip-measure` leaves them out; `--only <check>` runs one check.
 *
 * `--attach` runs the journey alone on the caller's terminal: the grid
 * appears, the scripted interactions run, and the proof waits for you to
 * detach (prefix, `d`) before tearing down.
 */

import { mkdtempSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { exec, Stdio } from "@effectionx/process";
import { exists, readTextFile } from "@effectionx/fs";
import { exit, main, sleep, until } from "effection";
import type { Operation } from "effection";
import {
  checkCancellationPoints,
  checkJourney,
  checkLayoutGeometry,
  checkMeasurements,
  checkNegativeChildren,
  checkReadinessBoundary,
  checkSignalsDistinct,
  checkStartupFailureAtomic,
} from "./checks.ts";
import type { CheckContext } from "./checks.ts";
import { Evidence, logger } from "./evidence.ts";
import type { Check } from "./evidence.ts";
import { tmuxAt } from "./provider.ts";
import { filteredEnvironment, usePrivateDirectory } from "./workspace.ts";

interface Options {
  inner: boolean;
  attach: boolean;
  out: string | undefined;
  runs: number;
  skipMeasure: boolean;
  only: string | undefined;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    inner: false,
    attach: false,
    out: undefined,
    runs: 20,
    skipMeasure: false,
    only: undefined,
  };
  for (let index = 0; index < argv.length; index++) {
    switch (argv[index]) {
      case "--inner":
        options.inner = true;
        break;
      case "--attach":
        options.attach = true;
        break;
      case "--out":
        options.out = argv[++index];
        break;
      case "--runs":
        options.runs = Number(argv[++index]);
        break;
      case "--skip-measure":
        options.skipMeasure = true;
        break;
      case "--only":
        options.only = argv[++index];
        break;
      default:
        throw new Error(`unknown option ${argv[index]}`);
    }
  }
  return options;
}

const REPO_ROOT = join(import.meta.dirname ?? ".", "..", "..", "..");

function* command(cmd: string, args: string[]): Operation<string> {
  const result = yield* exec(cmd, { arguments: args }).join();
  return result.stdout.trim();
}

function* environmentFacts(): Operation<Record<string, unknown>> {
  return {
    commit: yield* command("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"]),
    os: `${process.platform} ${yield* command("uname", ["-r"])}`,
    arch: process.arch,
    tmux: yield* command("tmux", ["-V"]),
    deno: (yield* command("deno", ["--version"])).split("\n")[0],
    date: new Date().toISOString(),
  };
}

function* runChecks(options: Options, outDirectory: string): Operation<number> {
  const log = logger(outDirectory);
  const evidence = new Evidence();
  Object.assign(evidence.environment, yield* environmentFacts());
  evidence.environment.command = [
    "deno",
    "task",
    "proof:tmux-pane-workers",
    ...process.argv.slice(2),
  ].join(" ");
  const context: CheckContext = {
    evidenceDirectory: join(outDirectory, "children"),
    log,
    attachable: process.stdout.isTTY === true,
    manualClose: options.attach,
  };
  yield* log(`evidence → ${outDirectory}; terminal: ${context.attachable ? "yes" : "no"}`);

  const checks: [string, (check: Check) => Operation<void>][] = options.attach
    ? [["journey", (check) => checkJourney(check, context)]]
    : [
        ["layout-geometry", (check) => checkLayoutGeometry(check, context)],
        ["readiness-boundary", (check) => checkReadinessBoundary(check, context)],
        ["journey", (check) => checkJourney(check, context)],
        ["startup-failure-atomic", (check) => checkStartupFailureAtomic(check, context)],
        ["signals-distinct", (check) => checkSignalsDistinct(check, context)],
        ["negative-children", (check) => checkNegativeChildren(check, context)],
        ["cancellation-points", (check) => checkCancellationPoints(check, context)],
        ["measurements", (check) => checkMeasurements(check, context, options.runs)],
      ];
  for (const [name, body] of checks) {
    if (options.only !== undefined && name !== options.only) {
      continue;
    }
    if (name === "measurements" && options.skipMeasure) {
      continue;
    }
    yield* evidence.run(name, body, log);
  }
  yield* evidence.write(outDirectory);
  const failed = evidence.checks.filter((check) => !check.ok).length;
  yield* log(`done: ${evidence.checks.length - failed}/${evidence.checks.length} checks passed`);
  return failed === 0 ? 0 : 1;
}

/** Run this same program inside a private outer tmux so it has a terminal. */
function* runWrapped(options: Options, outDirectory: string): Operation<number> {
  const directory = yield* usePrivateDirectory();
  const tmux = tmuxAt(join(directory, "o"), filteredEnvironment());
  const passthrough = ["--inner", "--out", outDirectory, "--runs", String(options.runs)];
  if (options.skipMeasure) {
    passthrough.push("--skip-measure");
  }
  if (options.only !== undefined) {
    passthrough.push("--only", options.only);
  }
  yield* tmux.run([
    "new-session",
    "-d",
    "-s",
    "outer",
    "-x",
    "200",
    "-y",
    "56",
    "-c",
    REPO_ROOT,
    "deno",
    "run",
    "--allow-all",
    join(import.meta.dirname ?? ".", "proof.ts"),
    ...passthrough,
  ]);
  yield* tmux.run(["set", "-g", "remain-on-exit", "on"]);
  process.stderr.write("running inside a private outer tmux session; progress follows\n");

  const progress = join(outDirectory, "progress.log");
  let relayed = 0;
  while (true) {
    if (yield* exists(progress)) {
      const bytes = yield* until(readFile(progress));
      if (bytes.length > relayed) {
        process.stderr.write(bytes.subarray(relayed));
        relayed = bytes.length;
      }
    }
    const dead = yield* tmux.tryRun([
      "display",
      "-p",
      "-t",
      "outer:0",
      "#{pane_dead} #{pane_dead_status}",
    ]);
    if (dead === undefined) {
      process.stderr.write("the outer tmux session ended unexpectedly\n");
      return 1;
    }
    const [isDead, status] = dead.split(" ");
    if (isDead === "1") {
      const code = Number(status);
      if (code !== 0) {
        const screen = yield* tmux.tryRun(["capture-pane", "-p", "-S", "-", "-t", "outer:0"]);
        process.stderr.write(`inner proof exited ${code}; its last screen:\n${screen ?? ""}\n`);
      }
      yield* tmux.tryRun(["kill-server"]);
      const summary = join(outDirectory, "summary.md");
      if (yield* exists(summary)) {
        process.stdout.write(yield* readTextFile(summary));
      }
      process.stdout.write(`\nevidence: ${outDirectory}\n`);
      return code;
    }
    yield* sleep(200);
  }
}

// Losing the terminal is a cancellation, not a crash: `main()` shuts down on
// SIGTERM, and SIGHUP is turned into one so the hidden servers of a run whose
// terminal vanished are torn down rather than orphaned.
process.on("SIGHUP", () => process.kill(process.pid, "SIGTERM"));

await main(function* () {
  const options = parseOptions(process.argv.slice(2));
  // tmux and ps output is collected, never echoed.
  yield* Stdio.around({
    *stdout() {
      // Collected by the caller, never echoed.
    },
    *stderr() {
      // Collected by the caller, never echoed.
    },
  });
  // oxlint-disable-next-line local/no-sync-filesystem
  const outDirectory = options.out ?? mkdtempSync(join(tmpdir(), "xmd-pane-proof-"));
  yield* until(mkdir(outDirectory, { recursive: true }));
  if (options.inner || options.attach) {
    const status = yield* runChecks(options, outDirectory);
    if (options.attach) {
      process.stdout.write(yield* readTextFile(join(outDirectory, "summary.md")));
      process.stdout.write(`\nevidence: ${outDirectory}\n`);
    }
    yield* exit(status);
  }
  yield* exit(yield* runWrapped(options, outDirectory));
});
