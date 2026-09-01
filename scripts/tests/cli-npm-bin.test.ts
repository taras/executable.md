/**
 * Build packages/cli and run the emitted bin under Node. The test-agent smoke
 * document drives a full session/prompt path, so the Node parent must relaunch
 * itself as `xmd test-agent` to pass — the bare `Deno.*` global that kept
 * `@executablemd/cli@0.5.0` off npm compiles fine under Deno and fails only
 * here.
 *
 * The build runs with `DNT_LOCAL_SIBLINGS=1`, so packages/cli and every
 * @executablemd sibling it depends on are built from this branch's sources. A
 * release build resolves those siblings from npm instead, which type-checks the
 * branch against the *previous* release — green until a branch changes a shared
 * API, then red for a reason the branch cannot fix. This is also the only
 * coverage of the local-sibling build mode.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, until } from "effection";
import { readTextFile, rm } from "@effectionx/fs";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Operation } from "effection";
import { exec, Stdio } from "@effectionx/process";
import type { ProcessResult } from "@effectionx/process";
import { timebox } from "@effectionx/timebox";
import { removeNpmOutput } from "./npm-output.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PKG_DIR = "packages/cli";
const OUT_DIR = path.join(ROOT, PKG_DIR, "npm");
const BIN = path.join(OUT_DIR, "esm/src/node.js");
const DOC = path.join(ROOT, "smoke-test/test-agent/README.md");

/** npm install and a full dnt type-check dominate this; the run itself is quick. */
const TIMEOUT = 600_000;

interface Manifest {
  version?: string;
}

function* readManifest(...segments: string[]): Operation<Manifest> {
  return JSON.parse(yield* readTextFile(path.join(ROOT, ...segments)));
}

function* buildCliPackage(version: string): Operation<ProcessResult> {
  // The builder narrates every file it emits; only its exit code matters here.
  yield* Stdio.around({
    *stdout() {},
    *stderr() {},
  });

  return yield* exec(Deno.execPath(), {
    arguments: ["run", "-A", "scripts/build-npm.ts", PKG_DIR, version],
    cwd: ROOT,
    env: {
      ...Deno.env.toObject(),
      // @effectionx/* peer-depend on effection `^3 || ^4`, which npm will not
      // match against the pinned 4.x prerelease — the same allowance
      // publish-one.yml makes.
      NPM_CONFIG_LEGACY_PEER_DEPS: "true",
      // Build the siblings from this branch rather than resolving the last
      // published versions of them.
      DNT_LOCAL_SIBLINGS: "1",
    },
  }).join();
}

/** Run the built bin under Node, the way an `npm i -g @executablemd/cli` user would. */
function runEmittedBin(args: string[]): Operation<ProcessResult> {
  return runEmittedBinIn(ROOT, args);
}

/** The same, from a working directory the caller chooses. */
function* runEmittedBinIn(cwd: string, args: string[]): Operation<ProcessResult> {
  const result = yield* timebox<ProcessResult>(TIMEOUT, function* () {
    return yield* exec("node", {
      arguments: [BIN, ...args],
      cwd,
      env: Deno.env.toObject(),
    }).join();
  });
  if (result.timeout) {
    throw new Error("the emitted npm bin timed out");
  }
  return result.value;
}

describe("npm CLI package", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("relaunches its test-agent worker under Node", function* () {
    yield* ensure(removeNpmOutput);
    const { version } = yield* readManifest(PKG_DIR, "deno.json");

    const built = yield* buildCliPackage(version ?? "0.0.0-dev");
    if (built.code !== 0) {
      throw new Error(`build-npm.ts exited ${built.code}\n${built.stderr}`);
    }

    const run = yield* runEmittedBin(["test", DOC]);
    if (run.code !== 0) {
      throw new Error(`the emitted npm bin exited ${run.code}\n${run.stderr}`);
    }

    expect(run.stdout).toContain("The review of **packages/core** at `abc123` passed.");
    expect(run.stdout).toContain("The review of **packages/core** passed.");
    // The nested `host="run"` child's own return. It reached a scripted agent
    // and a declared answer through a worker this package relaunched, which is
    // the whole of what a built npm bin has to get right for one.
    expect(run.stdout).toContain("You chose to approve the review.");
    expect(run.stdout).not.toContain("ERROR");

    // The Markdown this package executes itself ships beside the module that
    // reads it. dnt emits the module graph only, so an asset nothing imports is
    // absent from the package unless the build copies it — and the command
    // would then find no program to run, on Node and Bun while Deno stayed
    // green.
    for (const asset of ["plan-command.md", "Plan.md"]) {
      expect(yield* readTextFile(path.join(OUT_DIR, "esm/src/documents", asset))).toBe(
        yield* readTextFile(path.join(ROOT, PKG_DIR, "src/documents", asset)),
      );
    }
  });

  /**
   * The packaged `<Plan>` Component, as the published package reports it.
   *
   * `<Plan>` is packaged Markdown rather than a module, so what a build ships
   * under that name is exactly the kind of thing a module-graph emitter can
   * lose. Asking the built bin what it would let a document write is what makes
   * "the same Component in every distribution" a checked claim: the origin names
   * the asset, the digest names the bytes, and a build that shipped different
   * ones — or none — answers differently here rather than at a person's first
   * `xmd plan`.
   *
   * Run from a directory that is not the package, because the lookup must be
   * beside the module and never beside the caller.
   */
  it("reports the same <Plan> Component identity the source tree ships", function* () {
    yield* ensure(removeNpmOutput);
    const { version } = yield* readManifest(PKG_DIR, "deno.json");
    const built = yield* buildCliPackage(version ?? "0.0.0-dev");
    if (built.code !== 0) {
      throw new Error(`build-npm.ts exited ${built.code}\n${built.stderr}`);
    }

    const source = yield* readTextFile(path.join(ROOT, PKG_DIR, "src/documents/Plan.md"));
    const digest = createHash("sha256").update(source, "utf8").digest("hex");

    const elsewhere = yield* until(mkdtemp(path.join(tmpdir(), "xmd-npm-plan-")));
    yield* ensure(() => rm(elsewhere, { recursive: true, force: true }));
    const run = yield* runEmittedBinIn(elsewhere, ["syntax", "--json", "--include", elsewhere]);
    if (run.code !== 0) {
      throw new Error(`the emitted npm bin exited ${run.code}\n${run.stderr}`);
    }

    const catalog = JSON.parse(run.stdout);
    const entries = catalog.categories.flatMap(
      (category: { entries: unknown[] }) => category.entries,
    );
    const plan = entries.find((entry: { name?: string }) => entry?.name === "Plan");
    expect(plan).toBeDefined();
    expect(plan.sourceKind).toBe("declared-markdown");
    expect(plan.origin).toEqual({
      kind: "declared-markdown",
      origin: "@executablemd/cli/Plan.md",
      digest,
    });
    expect(plan.forms).toEqual(["paired"]);
    // And no private capability is syntax a document may write, in any build.
    for (const name of ["PlanInputs", "PlanAuthorship", "CheckDraft", "AdmitPlan"]) {
      expect(entries.map((entry: { name?: string }) => entry?.name)).not.toContain(name);
    }
  });
});
