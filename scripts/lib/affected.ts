/**
 * Which tests this worktree's changes affect, decided by Deno.
 *
 * Deno 2.9.1 has the dependency-aware selection and no way to print what it
 * selected: the pretty and TAP reporters lose module identity under
 * `--parallel`, JUnit names the module that *registered* each test — every
 * suite here is attributed to `packages/test-support/bdd.ts` — and coverage
 * needs the run to finish and wrote eighty thousand files for one selection.
 *
 * Explicit file arguments intersect with `--changed`, though, so one candidate
 * can be decided on its own without executing anything:
 *
 *     deno test --no-run --changed=<base> <candidate>
 *
 * and the absence of `No test modules were affected by the given changes` is
 * the answer. Sweeping the corpus that way reproduced Deno's own
 * discovery-driven selection exactly — 76 of 164 files, three times, under
 * three different flag sets.
 *
 * **Type-checking stays on.** The same sweep under `--no-check` returned 73:
 * the three missing files reach the change only through `import type`, and
 * type-only edges are in the affected graph only while checking is.
 *
 * Selection is captured *before* anything runs, so a failing or cancelled suite
 * can never leave the set unproven, and all three runtimes start together.
 *
 * ## The question selection cannot answer
 *
 * "Which tests depend on this file" says nothing when the file is in no test's
 * graph. `packages/cli/src/cli.ts` is such a file — the CLI suites spawn the
 * binary — and so is any component `execute.ts` reaches through
 * `import(file://…)`, and any file nothing imports yet. Each would select zero
 * tests and look like good news.
 *
 * `--related` asks that question directly, using the same graph: a path with no
 * static dependent among the corpus roots has not proven its reachability, and
 * an unproven path runs everything.
 */

import { all } from "effection";
import type { Operation } from "effection";
import { fileURLToPath } from "node:url";

import { captured } from "./captured.ts";
import { classify } from "./change-classes.ts";
import type { ClassName } from "./change-classes.ts";
import type { Change } from "./git-changes.ts";

/** Printed by `deno test` when the selection is empty. */
export const NO_MODULES = "No test modules were affected by the given changes";

/** What every probe and every run share, so they read one type-check cache. */
const FLAGS = ["--allow-all", "--frozen"];

export class ProbeError extends Error {}

export interface Probe {
  /** Whether the change set affects `candidate`. */
  affects(candidate: string): Operation<boolean>;
  /** Whether any of `candidates` statically depends on `path`. */
  reaches(path: string, candidates: string[]): Operation<boolean>;
}

export interface Escalation {
  cause: "trigger" | "unreachable" | "probe-failure";
  path: string;
  detail: string;
}

export interface Selection {
  files: string[];
  /** Whether the corpus ran whole rather than by selection. */
  everything: boolean;
  escalations: Escalation[];
}

export function denoProbe(binary: string, root: URL, base: string): Probe {
  const cwd = fileURLToPath(root);

  function* ask(args: string[]): Operation<boolean> {
    const result = yield* captured(binary, {
      arguments: ["test", ...FLAGS, "--no-run", ...args],
      cwd,
    });
    if (result.code !== 0) {
      throw new ProbeError(
        `\`deno test --no-run ${args.join(" ")}\` exited ${result.code}: ${result.stderr.trim()}`,
      );
    }
    return !result.stderr.includes(NO_MODULES);
  }

  return {
    affects: (candidate) => ask([`--changed=${base}`, candidate]),
    reaches: (path, candidates) => ask([`--related=${path}`, ...candidates]),
  };
}

/**
 * Ask about every candidate, a few at a time.
 *
 * The workers share one queue rather than a slice each, so a directory of
 * expensive graphs cannot leave one worker running alone; the result is sorted
 * because the order they finish in is not the order anything should report.
 */
function* sweep(probe: Probe, candidates: string[], limit: number): Operation<string[]> {
  const queue = [...candidates];
  const selected: string[] = [];

  function* worker(): Operation<void> {
    for (let candidate = queue.shift(); candidate !== undefined; candidate = queue.shift()) {
      if (yield* probe.affects(candidate)) {
        selected.push(candidate);
      }
    }
  }

  const width = Math.max(1, Math.min(limit, queue.length));
  yield* all(Array.from({ length: width }, worker));
  return selected.sort();
}

export interface SelectOptions {
  probe: Probe;
  corpus: string[];
  changes: Change[];
  concurrency: number;
}

/**
 * The selected corpus, and every reason it is wider than the graph alone
 * would make it.
 *
 * Escalation is one-way: a trigger, an unproven path, or a probe that failed
 * after the change set was read all widen the run to everything. Nothing here
 * narrows it.
 */
export function* select(options: SelectOptions): Operation<Selection> {
  const { probe, corpus, changes, concurrency } = options;
  const classification = classify(changes, corpus);

  const escalations: Escalation[] = classification.full.map((entry) => ({
    cause: "trigger",
    path: entry.change.path,
    detail: describe(entry.className),
  }));

  if (escalations.length > 0) {
    return { files: [...corpus], everything: true, escalations };
  }

  try {
    for (const path of classification.typescript) {
      if (!(yield* probe.reaches(path, corpus))) {
        escalations.push({
          cause: "unreachable",
          path,
          detail: "no test statically depends on it, so a selection result would prove nothing",
        });
      }
    }
    if (escalations.length > 0) {
      return { files: [...corpus], everything: true, escalations };
    }

    const selected = yield* sweep(probe, corpus, concurrency);
    const files = [...new Set([...selected, ...classification.testFiles])].sort();
    return { files, everything: false, escalations };
  } catch (error) {
    if (!(error instanceof ProbeError)) {
      throw error;
    }
    escalations.push({ cause: "probe-failure", path: "", detail: error.message });
    return { files: [...corpus], everything: true, escalations };
  }
}

function describe(className: ClassName): string {
  const reasons: Partial<Record<ClassName, string>> = {
    deletion: "a deleted path has no graph node, so selection cannot see what depended on it",
    "workspace-config": "workspace configuration changes what every module resolves to",
    "runtime-dependencies": "Node and Bun resolve and typecheck through it",
    "selection-machinery": "it decides what the corpus is, or what running it means",
    "test-harness": "every test imports it",
    "runtime-documents": "documents and fixtures are read while running, not imported",
    "bundle-inputs": "the generated bundle tests read is built from it",
    unknown: "this selector cannot classify the path",
  };
  return reasons[className] ?? `class ${className}`;
}
