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
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { ensure } from "effection";
import type { Operation } from "effection";
import { exec, Stdio } from "@effectionx/process";
import type { ProcessResult } from "@effectionx/process";
import { readdir, rm } from "@effectionx/fs";
import { timebox } from "@effectionx/timebox";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PKG_DIR = "packages/cli";
const OUT_DIR = path.join(ROOT, PKG_DIR, "npm");
const BIN = path.join(OUT_DIR, "esm/src/cli.js");
const DOC = path.join(ROOT, "smoke-test/test-agent/README.md");

/** npm install and a full dnt type-check dominate this; the run itself is quick. */
const TIMEOUT = 600_000;

interface Manifest {
  version?: string;
}

function readManifest(...segments: string[]): Manifest {
  return JSON.parse(Deno.readTextFileSync(path.join(ROOT, ...segments)));
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
function* runEmittedBin(args: string[]): Operation<ProcessResult> {
  const result = yield* timebox<ProcessResult>(TIMEOUT, function* () {
    return yield* exec("node", {
      arguments: [BIN, ...args],
      cwd: ROOT,
      env: Deno.env.toObject(),
    }).join();
  });
  if (result.timeout) {
    throw new Error("the emitted npm bin timed out");
  }
  return result.value;
}

/**
 * Remove every generated npm output directory. A local-sibling build writes one
 * per workspace member, and a stale one left behind is both a lint subject and
 * something a later build could mistake for current.
 */
function* removeBuildOutput(): Operation<void> {
  for (const member of yield* readdir(path.join(ROOT, "packages"))) {
    yield* rm(path.join(ROOT, "packages", member, "npm"), { recursive: true, force: true });
  }
}

describe("npm CLI package", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("relaunches its test-agent worker under Node", function* () {
    yield* ensure(removeBuildOutput);
    const { version } = readManifest(PKG_DIR, "deno.json");

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
    expect(run.stdout).not.toContain("ERROR");
  });
});
