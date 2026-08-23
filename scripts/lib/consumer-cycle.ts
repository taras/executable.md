/**
 * Consume the shared dependency layout and the generated bundle, in a loop.
 *
 * This is the half of the interference proof that stands where the damage would
 * land, so each cycle names the state it depends on and reads it, over and
 * over, for the producer's whole lifetime.
 *
 * **Resolution alone is not consumption.** A specifier can resolve to a path
 * that no longer has bytes behind it, so every resolved entry is read; and the
 * generated module is imported and checked against its own recorded byte counts
 * rather than merely being present.
 *
 * One file runs under all three runtimes because the claim is about them
 * resolving the same union of stores at the same time — three implementations
 * could drift into proving three slightly different things, invisibly. What is
 * genuinely per-runtime is only how the process is launched, which stays in
 * `scripts/verify.ts`. This module is listed in `tsconfig.node.json`, so a
 * `Deno.*` global here fails the portable typecheck.
 */

import { sleep, until } from "effection";
import type { Operation } from "effection";
import { exists, readTextFile, writeTextFile } from "@effectionx/fs";
import { createRequire } from "node:module";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import { byteLength } from "./web-client-module.ts";

/** The runtimes that consume the layout, and the order every report uses. */
export const RUNTIMES = ["deno", "node", "bun"] as const;

export type Runtime = (typeof RUNTIMES)[number];

export function isRuntime(name: string): name is Runtime {
  return (RUNTIMES as readonly string[]).includes(name);
}

/**
 * One specifier per store, resolved as a package entry rather than as
 * `<pkg>/package.json` — several of these packages do not expose that subpath
 * through their `exports`, and a probe that failed on the exports map rather
 * than on the tree would report the wrong thing. The same three
 * `scripts/probe-resolution.mjs` resolves once, statically.
 */
export const STORES: Record<string, string> = {
  pnpm: "tsx",
  deno: "@rjsf/shadcn",
  workspace: "@executablemd/core",
};

export const GENERATED = "packages/web/generated/client-bundle.ts";

/** How many cycles each phase completed. A zero is a hole in the proof. */
export interface CycleReport {
  runtime: Runtime;
  before: number;
  during: number;
  after: number;
}

/** The producer's lifetime, as the control directory spells it. */
export type Phase = "before" | "during" | "after";

export function readyPath(control: string, runtime: Runtime): string {
  return join(control, `${runtime}.ready`);
}

export function reportPath(control: string, runtime: Runtime): string {
  return join(control, `${runtime}.cycles.json`);
}

export const PRODUCING = "producing";
export const SETTLED = "settled";

export function signalPath(control: string, name: string): string {
  return join(control, name);
}

function* phaseOf(control: string): Operation<Phase> {
  if (yield* exists(signalPath(control, SETTLED))) {
    return "after";
  }
  if (yield* exists(signalPath(control, PRODUCING))) {
    return "during";
  }
  return "before";
}

/**
 * The generated module's exports, parsed rather than asserted.
 *
 * The byte counts are the point. A module that imported cleanly can still be
 * the wrong one — an older build, or a rename that published a partially
 * written file whose text happened to parse — and only the recorded lengths
 * tell that apart from a complete one.
 */
export function checkGenerated(loaded: unknown, from: string): void {
  if (typeof loaded !== "object" || loaded === null) {
    throw new Error(`${from} did not evaluate to a module`);
  }
  const module: Record<string, unknown> = { ...loaded };
  for (const name of ["clientJs", "themeCss"]) {
    const asset = module[name];
    const recorded = module[`${name}Bytes`];
    if (typeof asset !== "string") {
      throw new Error(`${from} exports ${name} as ${typeof asset}, expected a string`);
    }
    if (asset.length === 0) {
      throw new Error(`${from} exports an empty ${name}`);
    }
    if (typeof recorded !== "number") {
      throw new Error(`${from} exports ${name}Bytes as ${typeof recorded}, expected a number`);
    }
    const actual = byteLength(asset);
    if (actual !== recorded) {
      throw new Error(`${from} exports ${actual} bytes of ${name}, and records ${recorded}`);
    }
  }
}

/**
 * Resolve, read and import everything one cycle depends on.
 *
 * Throws on the first thing it cannot reach, because the proof is that none of
 * this is ever unreachable while the producer runs. The import carries a fresh
 * query so the runtime evaluates the file on disk rather than handing back the
 * copy it loaded last time.
 */
/**
 * Whether `path` lies inside `root`, both resolved through their real paths.
 *
 * Real paths on both sides because the two are not otherwise comparable: a
 * macOS temporary directory is handed out as `/var/...` and resolves to
 * `/private/var/...`, and pnpm's tree is reached through symlinks.
 */
function* inside(root: string, path: string): Operation<boolean> {
  const from = yield* until(realpath(root));
  const to = yield* until(realpath(path));
  const step = relative(from, to);
  return step !== "" && !step.startsWith("..") && !isAbsolute(step);
}

export function* cycle(
  root: string,
  sequence: number,
  stores: Record<string, string> = STORES,
): Operation<void> {
  const require = createRequire(join(root, "consumer.mjs"));

  for (const [store, specifier] of Object.entries(stores)) {
    let resolved: string;
    try {
      resolved = require.resolve(specifier);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new Error(`${store} store: ${specifier} does not resolve — ${why}`);
    }
    // Resolution walks *up* out of the worktree when the local package is gone,
    // and a hit outside it says nothing about the layout being proven — the
    // consumer would sail through a store this build had just deleted. Under
    // `tsx` that fallback reaches the repository's own tree, which is how this
    // was found: four cases passed on CI that had failed everywhere else.
    if (!(yield* inside(root, resolved))) {
      throw new Error(`${store} store: ${specifier} resolved outside the worktree, to ${resolved}`);
    }
    const bytes = yield* until(readFile(resolved));
    if (bytes.length === 0) {
      throw new Error(`${store} store: ${specifier} resolved to an empty entry at ${resolved}`);
    }
  }

  const generated = join(root, GENERATED);
  const fresh = `${pathToFileURL(generated).href}?cycle=${sequence}`;
  let loaded: unknown;
  try {
    loaded = yield* until(import(fresh));
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(`${GENERATED} did not import — ${why}`);
  }
  checkGenerated(loaded, GENERATED);
}

export interface ConsumerOptions {
  runtime: Runtime;
  /** The worktree being proven. */
  root: string;
  /** This invocation's control directory. Nothing here uses a repository path. */
  control: string;
  /** Cycles beyond which the loop stops waiting for a producer that never came. */
  limit?: number;
  /**
   * Which stores to consume, overriding `STORES`.
   *
   * A fixture cannot stand in for every one of them: `tsx` resolves
   * `@executablemd/*` through `tsconfig.node.json`'s `paths`, so the workspace
   * store always reaches the real repository however the fixture is arranged.
   * A test that needs a temporary worktree names the two it can plant.
   */
  stores?: Record<string, string>;
}

/**
 * Cycle until the producer has settled, then once more.
 *
 * The phase is read *before* each cycle, so a cycle that begins while the
 * producer is alive counts as an overlap even if the producer settles part way
 * through it. That is the honest direction: what the cycle observed, it
 * observed while the build was running.
 */
export function* consume(options: ConsumerOptions): Operation<CycleReport> {
  const { runtime, root, control } = options;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const counted: CycleReport = { runtime, before: 0, during: 0, after: 0 };
  let sequence = 0;

  while (true) {
    const phase = yield* phaseOf(control);
    yield* cycle(root, sequence++, options.stores);
    counted[phase]++;

    if (sequence === 1) {
      yield* writeTextFile(readyPath(control, runtime), `${runtime}\n`);
    }
    if (phase === "after" || sequence >= limit) {
      break;
    }
    // Only so a consumer that outruns the filesystem does not spin the core the
    // producer needs. Not an idle period: the next cycle begins immediately.
    yield* sleep(0);
  }

  yield* writeTextFile(reportPath(control, runtime), `${JSON.stringify(counted)}\n`);
  return counted;
}

/** What a consumer recorded, or `undefined` when it never got that far. */
export function* cyclesOf(control: string, runtime: Runtime): Operation<CycleReport | undefined> {
  const path = reportPath(control, runtime);
  if (!(yield* exists(path))) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(yield* readTextFile(path));
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const record: Record<string, unknown> = { ...parsed };
  const counts = ["before", "during", "after"].map((phase) => record[phase]);
  if (!counts.every((count) => typeof count === "number")) {
    return undefined;
  }
  const [before, during, after] = counts;
  return { runtime, before, during, after };
}
