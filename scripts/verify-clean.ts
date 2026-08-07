/**
 * Prove, against a clean checkout, that only preparation installs.
 *
 * Usage:
 *   deno task verify:clean
 *
 * The chain is the claim this repository makes:
 *
 *     deno task setup → deps:target → build:web → build → the release compile
 *                     → resolution probe → verify --no-site
 *
 * Two claims, because a build and a check are different things.
 *
 * **A build is cache-pure.** `build:web`, `build`, and the release compile run
 * offline and must leave `node_modules`, the Deno cache's dependency content,
 * and `deno.lock` byte-identical — a build that fetches has installed
 * something.
 *
 * **Verification is not, and does not claim to be.** The battery resolves
 * modules no build walks — the dnt graph behind `scripts/build-npm.ts`, which
 * only a test executes — so it adds to the Deno cache, which the runtime owns.
 * What it may never move is what this repository owns: `node_modules` and
 * `deno.lock`. That is the comparison its phases make.
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

import { ensure, exit, main, scoped } from "effection";
import type { Operation } from "effection";
import { exec } from "@effectionx/process";
import { rm } from "@effectionx/fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  changes,
  hostChanges,
  hostState,
  hostStateChanges,
  POPULATED_ROOTS,
  preparedState,
} from "./lib/prepared-state.ts";
import type { HostState, PreparedState } from "./lib/prepared-state.ts";
import { writeTextFile } from "@effectionx/fs";
import { RELEASE_TARGET } from "./lib/release-targets.ts";

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
 * The four acts of the site proof, in the only order that proves anything.
 *
 * They are parameters rather than statements so a regression can record the
 * order they happen in. The one that matters is `changeSite` before `baseline`:
 * reversed, the edit lands after the battery's opening snapshot and reads as a
 * dirtied tree instead of the state the battery was asked to preserve.
 */
export interface SiteProof {
  changeSite(): Operation<void>;
  baseline(): Operation<HostState>;
  battery(): Operation<boolean>;
  after(): Operation<HostState>;
}

/** The site-enabled battery, and what it moved. `false` when the battery failed. */
export function* siteEnabledBattery(proof: SiteProof): Operation<string[] | false> {
  yield* proof.changeSite();
  const before = yield* proof.baseline();
  if (!(yield* proof.battery())) {
    return false;
  }
  return hostStateChanges(before, yield* proof.after());
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

function* scratch(prefix: string): Operation<string> {
  // @effectionx/fs has no mkdtemp.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  yield* ensure(() => rm(directory, { recursive: true, force: true }));
  return directory;
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
 */
function* hostStateOf(target: string, label: string): Operation<HostState> {
  const started = performance.now();
  const state = yield* hostState(target);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(
    `  host state after ${label}: ${state.tree.entries.length} tree entries (${seconds}s)`,
  );
  return state;
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
     * The battery itself, which subsumes the `tsc` that used to run here:
     * `deno task verify` runs every applicable check beside every other one,
     * concurrently, and fails if any of them dirties the clone's tracked tree.
     *
     * Site-enabled, and once. The clone gets a real `site/` change first, so
     * applicability selects the pair from a change rather than from a fixture
     * and all ten commands run together. `siteEnabledBattery` fixes the order:
     * the edit lands before the baseline snapshot, which is what makes it the
     * state the battery must preserve rather than a dirty tree it would report.
     * Running a second `--no-site` battery to cover the other branch would
     * double the longest job in CI to prove what focused tests already cover.
     *
     * The comparison afterwards reads only what this repository owns. The
     * battery resolves module graphs no build walks — the dnt graph behind
     * `scripts/build-npm.ts` among them — so it legitimately adds to the
     * runtime-owned cache, and `hostState` never asks where that cache is.
     */
    const moved = yield* siteEnabledBattery({
      *changeSite() {
        yield* writeTextFile(
          path.join(target, "site", "verify-clean.probe.md"),
          "Written by `deno task verify:clean` so the site pair applies.\n",
        );
      },
      baseline: () => hostStateOf(target, "the site change"),
      battery: () =>
        step({
          label: "verify (site pair included)",
          command: deno,
          arguments: ["task", "verify"],
          cwd: target,
          env: { DENO_DIR: denoDir },
        }),
      after: () => hostStateOf(target, "the battery"),
    });

    if (moved === false) {
      return true;
    }
    if (moved.length > 0) {
      console.error(`\n✗ the battery changed node_modules or the lockfile:\n${moved.join("\n")}`);
      return true;
    }

    return false;
  });

  if (failed) {
    yield* exit(1);
  }
  console.log("\nthe chain holds: preparation installs, and nothing else does");
});
