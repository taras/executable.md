/**
 * Run the tests this branch and worktree affect, under all three runtimes.
 *
 * Usage:
 *   deno task test:affected                 # against origin/main
 *   deno task test:affected --base HEAD~3   # against another ref
 *   deno task test:affected --all           # every applicable test, no selection
 *
 * Deno decides which tests are affected (`lib/affected.ts`); this file decides
 * what the answer is worth. It reads the change set with status intact, widens
 * the run for every input the module graph cannot see (`lib/change-classes.ts`),
 * and only then hands the surviving TypeScript to Deno.
 *
 * The three runtimes receive one selected set — Deno's — minus each runtime's
 * recorded exclusions. None of them rediscovers affectedness, so none of them
 * can drift from the others.
 *
 * Two failures are not the same failure. A change set that cannot be read or a
 * base that cannot be resolved stops the command with remediation and runs
 * nothing: guessing there would mean reporting a green that covered nothing.
 * A probe that fails after the change set was read runs *everything* and says
 * which probe failed. Narrowing is never the answer to an error.
 *
 * This is not equivalent to CI, and the report says so on every run.
 */

import { allSettled, exit, main } from "effection";
import type { Operation, Result } from "effection";
import { fileURLToPath } from "node:url";

import { captured } from "./lib/captured.ts";
import { denoProbe, select } from "./lib/affected.ts";
import type { Escalation, Selection } from "./lib/affected.ts";
import { changeSet, GitChangeError } from "./lib/git-changes.ts";
import type { Change, ChangeSet } from "./lib/git-changes.ts";
import { listTestFiles } from "./lib/test-files.ts";
import { RUNNERS } from "./lib/runtime-tests.ts";
import { exclusions } from "./runtime-test-exclusions.ts";

const repoRoot = new URL("../", import.meta.url);
const root = fileURLToPath(repoRoot);

const DEFAULT_BASE = "origin/main";

/** Every runtime the corpus runs under, in report order. */
const RUNTIMES = ["deno", "node", "bun"] as const;
type Runtime = (typeof RUNTIMES)[number];

interface Options {
  base: string;
  everything: boolean;
  concurrency: number;
}

interface Outcome {
  runtime: Runtime;
  command: string[];
  code: number;
  seconds: number;
  output: string;
}

export function parseOptions(args: string[]): Options {
  const options: Options = {
    base: DEFAULT_BASE,
    everything: false,
    concurrency: Math.max(1, Math.min(8, navigator.hardwareConcurrency)),
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--all") {
      options.everything = true;
      continue;
    }
    if (argument === "--base") {
      const base = args[index + 1];
      if (base === undefined) {
        throw new Error("--base needs a git ref");
      }
      options.base = base;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument \`${argument}\``);
  }
  return options;
}

/** The command line each runtime runs, given the files it is responsible for. */
function commandFor(runtime: Runtime, files: string[]): string[] {
  if (runtime === "deno") {
    return [Deno.execPath(), "test", "--allow-all", "--frozen", ...files];
  }
  const runner = RUNNERS[runtime]!;
  return [runner.command, ...runner.prefix, ...files];
}

function filesFor(runtime: Runtime, selected: string[]): string[] {
  const skip = new Set((exclusions[runtime] ?? []).map((entry) => entry.path));
  return selected.filter((file) => !skip.has(file));
}

/**
 * `tsx` and `bun` are resolved through the workspace's own bin directory: this
 * process runs under Deno, which does not put it on the path the way an npm
 * script would.
 */
function environment(): Record<string, string> {
  const path = Deno.env.get("PATH") ?? "";
  return { ...Deno.env.toObject(), PATH: `${root}node_modules/.bin:${path}` };
}

function* run(runtime: Runtime, files: string[]): Operation<Outcome> {
  const command = commandFor(runtime, files);
  const started = performance.now();
  const [program, ...args] = command;
  const result = yield* captured(program!, {
    arguments: args,
    cwd: root,
    env: environment(),
  });
  return {
    runtime,
    command,
    code: result.code,
    seconds: Math.round((performance.now() - started) / 100) / 10,
    output: result.output,
  };
}

/** A runner that never started still failed, and its runtime still reports. */
function unwrap(runtime: Runtime, result: Result<Outcome>): Outcome {
  if (result.ok) {
    return result.value;
  }
  return {
    runtime,
    command: commandFor(runtime, []),
    code: 1,
    seconds: 0,
    output: `${runtime} runner did not run: ${result.error.message}`,
  };
}

const STATUS: Record<string, string> = { added: "A", modified: "M", deleted: "D" };

function reportChanges(changes: Change[]): void {
  console.log(`\nchanged paths (${changes.length})`);
  for (const change of changes) {
    console.log(`  ${STATUS[change.kind]}  ${change.path}`);
  }
}

function reportEscalations(escalations: Escalation[]): void {
  console.log("\nrunning the full corpus");
  for (const escalation of escalations) {
    const subject = escalation.path === "" ? escalation.cause : escalation.path;
    console.log(`  ${subject}\n      ${escalation.detail}`);
  }
}

function reportSelection(selection: Selection, corpus: string[]): void {
  console.log(
    `\nselected ${selection.files.length} of ${corpus.length} test files` +
      `${selection.everything ? " (the whole corpus)" : ""}`,
  );
  const skipped = new Map<string, string[]>();
  for (const runtime of RUNTIMES) {
    for (const entry of exclusions[runtime] ?? []) {
      skipped.set(entry.path, [...(skipped.get(entry.path) ?? []), runtime]);
    }
  }
  for (const file of selection.files) {
    const runtimes = RUNTIMES.map((runtime) =>
      (skipped.get(file) ?? []).includes(runtime) ? "—" : runtime[0],
    );
    console.log(`  ${runtimes.join(" ")}  ${file}`);
  }
  for (const runtime of RUNTIMES) {
    for (const entry of exclusions[runtime] ?? []) {
      if (selection.files.includes(entry.path)) {
        console.log(
          `\n  excluded from ${runtime}: ${entry.path}\n      ${entry.reason}\n      ${entry.issue}`,
        );
      }
    }
  }
}

/** Checks this command does not run, which a change can still make applicable. */
function reportSeparateChecks(changes: Change[]): void {
  const paths = changes.map((change) => change.path);
  const applicable = [
    "deno task lint",
    "deno task check",
    "deno task check:jsr",
    "deno task build && ./dist/xmd test smoke-test/README.md …  (compiled smoke)",
    "deno task xmd test packages/core/src --raw",
  ];
  if (paths.some((path) => path.startsWith("site/"))) {
    applicable.push("(cd site && deno task check)", "(cd site && deno task build)");
  }
  console.log("\nthis command runs tests only — still applicable:");
  for (const check of applicable) {
    console.log(`  ${check}`);
  }
  console.log(
    "\nCI runs the complete corpus under every runtime. This run is not equivalent to it.",
  );
}

function reportOutcomes(outcomes: Outcome[]): void {
  console.log("\nresults");
  for (const outcome of outcomes) {
    const verdict = outcome.code === 0 ? "passed" : `FAILED (exit ${outcome.code})`;
    console.log(`  ${outcome.runtime.padEnd(5)} ${verdict} in ${outcome.seconds}s`);
  }
  for (const outcome of outcomes.filter((entry) => entry.code !== 0)) {
    console.log(`\n─── ${outcome.runtime} output ───`);
    console.log(outcome.output.trimEnd());
    console.log(`\nre-run with:\n  ${outcome.command.join(" ")}`);
  }
}

function* stop(message: string, remedy: string): Operation<void> {
  console.error(`${message}\n  ${remedy}`);
  yield* exit(1);
}

/**
 * The change set, or a stop. An unreadable git state is never "no changes":
 * that would report a green covering nothing.
 */
function* readChanges(base: string): Operation<ChangeSet> {
  try {
    return yield* changeSet(repoRoot, base);
  } catch (error) {
    if (error instanceof GitChangeError) {
      yield* stop(
        `cannot read what changed against \`${base}\`: ${error.message}`,
        `fetch the base first (\`git fetch origin main\`), or name another with --base`,
      );
    }
    throw error;
  }
}

export function* affectedTests(args: string[]): Operation<void> {
  const options = parseOptions(args);
  const corpus = yield* listTestFiles(repoRoot);

  let selection: Selection = { files: [...corpus], everything: true, escalations: [] };
  let changes: Change[] = [];

  if (options.everything) {
    console.log("--all: every applicable test, no selection");
  } else {
    const found = yield* readChanges(options.base);
    changes = found.changes;
    console.log(`affected tests — base ${found.base} (merge base ${found.mergeBase.slice(0, 7)})`);
    reportChanges(changes);
    selection = yield* select({
      probe: denoProbe(Deno.execPath(), repoRoot, found.mergeBase),
      corpus,
      changes,
      concurrency: options.concurrency,
    });
    if (selection.escalations.length > 0) {
      reportEscalations(selection.escalations);
    }
  }

  reportSelection(selection, corpus);

  if (selection.files.length === 0) {
    console.log("\nno affected tests — nothing to run");
    reportSeparateChecks(changes);
    return;
  }

  console.log("\nrunning");
  // Every runtime finishes: one runtime's failure is not a reason to lose
  // another's result, and the selection they share was settled before any ran.
  const settled = yield* allSettled(
    RUNTIMES.map((runtime) => run(runtime, filesFor(runtime, selection.files))),
  );
  const outcomes = settled.map((result, index) => unwrap(RUNTIMES[index]!, result));

  reportOutcomes(outcomes);
  reportSeparateChecks(changes);

  if (outcomes.some((outcome) => outcome.code !== 0)) {
    yield* exit(1);
  }
}

if (import.meta.main) {
  await main((args) => affectedTests(args));
}
