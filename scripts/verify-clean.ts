/**
 * Prove, against a clean checkout, that only preparation installs.
 *
 * Usage:
 *   deno task verify:clean
 *
 * The chain is the claim this repository makes:
 *
 *     deno task setup → deps:target → build:web → build → the release compile
 *                     → resolution probe → the interference proof
 *
 * Two claims, because a build and a check are different things.
 *
 * **A build is cache-pure.** `build:web`, `build`, and the release compile run
 * offline and must leave `node_modules`, the Deno cache's dependency content,
 * and `deno.lock` byte-identical — a build that fetches has installed
 * something.
 *
 * **The interference proof is not, and does not claim to be.** It resolves
 * modules no build walks, so it adds to the Deno cache, which the runtime owns.
 * What it may never move is what this repository owns: `node_modules` and
 * `deno.lock`. That is the comparison its phases make. What it proves beyond
 * that is narrower than the battery it replaced and is the reason this job
 * exists: that the real producer cannot corrupt or replace the state Deno, Node
 * and Bun are resolving through while it runs.
 *
 * `deno task setup` owns the clone's `node_modules`, its lockfile, and the
 * scratch cache. `deps:target` adds one release target's npm graph to that
 * cache — the release phase compiles for another platform under `--cached-only`,
 * and host preparation never cached its packages — and must leave the host's
 * `node_modules` and lockfile untouched, which is checked by fingerprinting
 * those parts either side of it. Every phase after that must leave all three
 * byte-identical, and
 * every phase runs with the network unreachable, so a phase that would fetch
 * fails outright instead of being caught afterwards. Offline shows nothing was
 * fetched; the fingerprint shows nothing was changed (#279).
 *
 * Four snapshots, not one at the end: a phase that mutated state and a later
 * phase that restored it would compare equal, and the phase that broke the rule
 * is the thing worth naming.
 *
 * Everything happens in a clone of `HEAD` with a `DENO_DIR` of its own, so the
 * run neither reads nor writes the caller's tree or cache — and no other process on
 * the machine can move what it is measuring. This harness therefore installs
 * nothing itself, which is why its own task runs
 * `--node-modules-dir=none --cached-only --frozen`.
 */

import { exit, main, scoped } from "effection";
import type { Operation } from "effection";
import { exec } from "@effectionx/process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  changes,
  hostChanges,
  hostState,
  POPULATED_ROOTS,
  preparedState,
} from "./lib/prepared-state.ts";
import type { PreparedState } from "./lib/prepared-state.ts";
import { trackedState } from "./lib/tracked-fingerprint.ts";
import { movedOwned } from "./lib/verify.ts";
import type { OwnedState } from "./lib/verify.ts";
import { RELEASE_TARGET } from "./lib/release-targets.ts";
import { useTempDirectory } from "./lib/temp-directory.ts";

const repoRoot = new URL("../", import.meta.url);
const root = fileURLToPath(repoRoot);

/**
 * A proxy nothing listens on. Deno honours these, so a phase that reaches for
 * the network fails rather than succeeding quietly from a warm cache.
 *
 * `NPM_CONFIG_REGISTRY` is deliberately absent: Deno keys its npm cache by
 * registry host, so pointing that elsewhere produces a cache miss that looks
 * like a fetch attempt and proves nothing.
 */
const OFFLINE = {
  HTTP_PROXY: "http://127.0.0.1:1",
  HTTPS_PROXY: "http://127.0.0.1:1",
  ALL_PROXY: "http://127.0.0.1:1",
};

export interface Phase {
  label: string;
  arguments: string[];
}

/**
 * The three acts of the interference proof, in the only order that proves
 * anything.
 *
 * They are parameters rather than statements so a regression can record the
 * order they happen in, and can put a failing probe in the middle. The order is
 * the whole contract: the snapshot before, the probe, and the snapshot after —
 * with nothing between the probe and the comparison that could skip it.
 *
 * The snapshots are `OwnedState`, the same shape and the same comparison the
 * probe uses inside itself. `hostState()` alone would cover `node_modules` and
 * the lockfile and say nothing about tracked files — and the probe process
 * failing is exactly the case where its own comparison did not get to run, so
 * this one has to describe everything that could have moved.
 */
export interface InterferenceProof {
  baseline(): Operation<OwnedState>;
  probe(): Operation<boolean>;
  after(): Operation<OwnedState>;
}

/** Whether the probe passed, and what it moved. Both, always. */
export interface Interference {
  passed: boolean;
  moved: string[];
}

/**
 * Run the probe between two snapshots of repository-owned state.
 *
 * The comparison runs whether the probe passed or not. A failed probe is
 * exactly when a moved `node_modules` or lockfile would otherwise go
 * unreported — the run is already going to exit non-zero, and the reason it
 * exits is the thing worth naming completely.
 */
export function* interferenceProof(proof: InterferenceProof): Operation<Interference> {
  const before = yield* proof.baseline();
  const passed = yield* proof.probe();
  return { passed, moved: movedOwned(before, yield* proof.after()) };
}

/** The build phases, each exactly as a task or a workflow invokes it. */
export function phases(binary: string): Phase[] {
  return [
    { label: "build:web", arguments: ["task", "build:web"] },
    { label: "build", arguments: ["task", "build"] },
    {
      label: "release compile",
      arguments: [
        "compile",
        "--node-modules-dir=none",
        "--cached-only",
        "--frozen",
        "--exclude-unused-npm",
        "--allow-all",
        "--include",
        "packages/code-review-agent",
        "--target",
        RELEASE_TARGET,
        "--output",
        `dist/${binary}`,
        "packages/cli/src/compiled.ts",
      ],
    },
  ];
}

function scratch(prefix: string): Operation<string> {
  return useTempDirectory(prefix);
}

/** A clean checkout of `HEAD`, which is what "from a clean checkout" means. */
function* clone(): Operation<string> {
  const target = yield* scratch("xmd-verify-clean-");
  yield* exec("git", {
    arguments: ["clone", "--shared", "--quiet", root, target],
    cwd: root,
  }).expect();
  return target;
}

interface Run {
  label: string;
  command: string;
  arguments: string[];
  cwd: string;
  env: Record<string, string>;
}

function* step(run: Run): Operation<boolean> {
  const started = performance.now();
  const status = yield* exec(run.command, {
    arguments: run.arguments,
    cwd: run.cwd,
    env: { ...Deno.env.toObject(), ...run.env },
  }).join();
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const ok = status.code === 0;
  console.log(`${ok ? "✓" : "✗"} ${run.label} (${seconds}s)`);
  return ok;
}

/**
 * The repository-owned snapshot, timed like the full one so the two are
 * comparable in the log — and visibly cheaper, because it walks no cache.
 *
 * Tracked paths are part of it. A probe that rewrote a source file, flipped an
 * executable bit or replaced a symlink would leave `node_modules` and the
 * lockfile untouched, and the whole point of this comparison is that it still
 * runs when the probe's own one did not.
 */
function* ownedStateOf(target: string, label: string): Operation<OwnedState> {
  const started = performance.now();
  const host = yield* hostState(target);
  const tracked = yield* trackedState(target);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(
    `  owned state after ${label}: ${host.tree.entries.length} tree entries, ` +
      `${tracked.size} tracked (${seconds}s)`,
  );
  return { tracked, installed: host.tree.entries, lock: host.lock };
}

function* fingerprintOf(target: string, denoDir: string, label: string): Operation<PreparedState> {
  const started = performance.now();
  const state = yield* preparedState(target, denoDir);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(
    `  fingerprint after ${label}: ${state.tree.entries.length} tree, ` +
      `${state.cache.entries.length} cache, roots ${state.cache.roots.join(", ")} (${seconds}s)`,
  );
  return state;
}

main(function* () {
  const failed = yield* scoped(function* () {
    const target = yield* clone();
    const denoDir = yield* scratch("xmd-verify-clean-cache-");
    const deno = Deno.execPath();
    console.log(`clean checkout: ${target}\nscratch DENO_DIR: ${denoDir}\n`);

    const prepared = yield* step({
      label: "setup",
      command: deno,
      arguments: ["task", "setup"],
      cwd: target,
      env: { DENO_DIR: denoDir },
    });
    if (!prepared) {
      return true;
    }

    // Target preparation, and the proof that it only adds to the cache. The
    // release phase below compiles `--cached-only` for another platform, whose
    // npm packages host preparation never cached; this is the step that caches
    // them, and `--node-modules-dir=none` is what keeps it out of the host's
    // `node_modules`. Fingerprinting the host's own state either side is how
    // that claim is checked rather than asserted.
    const beforeTarget = yield* fingerprintOf(target, denoDir, "setup");
    const targetPrepared = yield* step({
      label: `deps:target ${RELEASE_TARGET}`,
      command: deno,
      arguments: ["task", "deps:target", RELEASE_TARGET],
      cwd: target,
      env: { DENO_DIR: denoDir },
    });
    if (!targetPrepared) {
      return true;
    }
    const hostMoved = hostChanges(
      beforeTarget,
      yield* fingerprintOf(target, denoDir, "deps:target"),
    );
    if (hostMoved.length > 0) {
      console.error(
        `\n✗ target preparation changed the host tree or lock:\n${hostMoved.join("\n")}`,
      );
      return true;
    }

    // `deno compile` fetches Deno's own runtime shim (`denort`) into the cache's
    // `dl/` the first time it compiles for a target. That is toolchain, not a
    // project dependency — not in the lock, not governed by `--cached-only`, and
    // `dl/` is not a content root — but a scratch cache has never seen it, so
    // the phases below could not run offline without this. Warming it keeps "a
    // build fetches no dependency" an assertion rather than an excuse.
    //
    // Two, because the chain compiles for two targets: `deno task build` for
    // the host, the release phase always for `RELEASE_TARGET`.
    for (const compiled of [undefined, RELEASE_TARGET]) {
      const warmed = yield* step({
        label: `warm the runtime shim for ${compiled ?? "the host"}`,
        command: deno,
        arguments: [
          "compile",
          "--no-config",
          ...(compiled ? ["--target", compiled] : []),
          "--output",
          path.join(denoDir, `warm-up-${compiled ?? "host"}`),
          path.join(target, "scripts", "probe-resolution.mjs"),
        ],
        cwd: target,
        env: { DENO_DIR: denoDir },
      });
      if (!warmed) {
        return true;
      }
    }

    const baseline = yield* fingerprintOf(target, denoDir, "preparation");
    for (const root of POPULATED_ROOTS) {
      if (!baseline.cache.roots.includes(root)) {
        console.error(`✗ preparation left ${root} empty; the fingerprint would prove nothing`);
        return true;
      }
    }

    for (const phase of phases("xmd-release")) {
      const ran = yield* step({
        label: phase.label,
        command: deno,
        arguments: phase.arguments,
        cwd: target,
        env: { DENO_DIR: denoDir, ...OFFLINE },
      });
      if (!ran) {
        return true;
      }
      const moved = changes(baseline, yield* fingerprintOf(target, denoDir, phase.label));
      if (moved.length > 0) {
        console.error(`\n✗ ${phase.label} changed prepared state:\n${moved.join("\n")}`);
        return true;
      }
    }

    if (
      !(yield* step({
        label: "resolution probe",
        command: "node",
        arguments: ["scripts/probe-resolution.mjs"],
        cwd: target,
        env: { DENO_DIR: denoDir },
      }))
    ) {
      return true;
    }

    /**
     * The interference proof: `deno task build:web` republishing the generated
     * bundle while Deno, Node and Bun resolve and read through the same
     * `node_modules` and import the same module.
     *
     * This is the one thing the clean checkout adds load to that focused tests
     * cannot. It is not a second correctness suite — the complete Deno, Node
     * and Bun suites run once each in their own CI jobs, and duplicating them
     * here cost 26 of this job's 31 minutes to prove nothing about ownership
     * (#546).
     *
     * The comparison afterwards reads only what this repository owns. The probe
     * resolves module graphs no build walks, so it legitimately adds to the
     * runtime-owned cache, and `hostState` never asks where that cache is.
     */
    const { passed, moved } = yield* interferenceProof({
      baseline: () => ownedStateOf(target, "the offline builds"),
      probe: () =>
        step({
          label: "interference proof",
          command: deno,
          arguments: ["task", "verify"],
          cwd: target,
          env: { DENO_DIR: denoDir },
        }),
      after: () => ownedStateOf(target, "the interference proof"),
    });

    if (moved.length > 0) {
      console.error(
        `\n✗ the probe changed tracked files, node_modules or the lockfile:\n${moved.join("\n")}`,
      );
    }
    return !passed || moved.length > 0;
  });

  if (failed) {
    yield* exit(1);
  }
  console.log("\nthe chain holds: preparation installs, and nothing else does");
});
