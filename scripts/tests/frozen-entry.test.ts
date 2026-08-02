import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure } from "effection";
import type { Operation } from "effection";
import { readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RELEASE_TARGET } from "../lib/release-targets.ts";

const REPO_ROOT = new URL("../../", import.meta.url);

/**
 * `deno.lock` is tracked, so no task may rewrite it — and the guarantee has to
 * hold at each task's *outer* entry, not only at the install inside it. An
 * unfrozen `deno run` repairs the lock while resolving the script's own graph,
 * before a line of that script runs, which is exactly how `deno task deps` came
 * to exit 0 on a stale lock and leave it rewritten (#279).
 *
 * Each case runs in a clone of `HEAD`, so a failure cannot touch this worktree,
 * and each fails at the entry boundary before any install — which is what keeps
 * three process spawns affordable. A clone carries the committed task
 * definitions, so run these against a committed change.
 */
function* clone(): Operation<string> {
  // @effectionx/fs has no mkdtemp.
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "frozen-entry-"));
  yield* ensure(() => rm(target, { recursive: true, force: true }));

  yield* exec("git", {
    arguments: ["clone", "--shared", "--quiet", fileURLToPath(REPO_ROOT), target],
    cwd: fileURLToPath(REPO_ROOT),
  }).expect();
  return target;
}

function* staleClone(): Operation<string> {
  const target = yield* clone();

  const lock = path.join(target, "deno.lock");
  const contents = JSON.parse(yield* readTextFile(lock));
  const specifier = Object.keys(contents.specifiers).find((key) => key.startsWith("npm:"));
  delete contents.specifiers[specifier ?? ""];
  yield* writeTextFile(lock, `${JSON.stringify(contents, null, 2)}\n`);
  return target;
}

interface Attempt {
  code?: number;
  output: string;
  lock: string;
}

function* attempt(target: string, task: string, args: string[] = []): Operation<Attempt> {
  const lock = path.join(target, "deno.lock");
  const before = yield* readTextFile(lock);
  const result = yield* exec(Deno.execPath(), {
    arguments: ["task", task, ...args],
    cwd: target,
  }).join();
  const after = yield* readTextFile(lock);

  expect(after).toEqual(before);
  return { code: result.code, output: `${result.stdout}${result.stderr}`, lock: after };
}

describe("a stale lockfile stops every dependency-loading task", () => {
  /**
   * The diagnostic is asserted, not just the exit code. `verify:clean` runs
   * `--cached-only`, so a missing cache entry would also exit non-zero — with
   * `Failed loading https://registry.npmjs.org/…` — and a test that accepted any
   * failure would pass while the lockfile guarantee was gone.
   */
  for (const task of ["deps", "setup", "verify:clean", "deps:target"]) {
    it(`${task} refuses, names the lockfile, and leaves it byte-identical`, function* () {
      const clone = yield* staleClone();

      // `deps:target` needs the target its mapping is keyed by; the others take
      // no argument. The lockfile check comes first either way.
      const { code, output } = yield* attempt(
        clone,
        task,
        task === "deps:target" ? [RELEASE_TARGET] : [],
      );

      expect(code).not.toBe(0);
      expect(output).toContain("lockfile is out of date");
    });
  }
});

/**
 * An unknown target is refused by the mapping, before a process is spawned — so
 * it costs a message rather than an install of the wrong platform. The clone is
 * left alone here: a stale lock would stop the task runner first, and the
 * refusal under test happens further in.
 */
describe("deps:target and an unknown target", () => {
  it("refuses by naming the mapping, and installs nothing", function* () {
    const target = yield* clone();

    const { code, output } = yield* attempt(target, "deps:target", ["sparc-sun-solaris"]);

    expect(code).not.toBe(0);
    expect(output).toContain("unknown release target");
    expect(output).toContain(RELEASE_TARGET);
    // The line the script prints immediately before it spawns the install. Its
    // absence is what shows the mapping refused first — `deno task`'s own
    // workspace resolution prints package names either way, so that is no
    // evidence of anything.
    expect(output).not.toContain("caching the");
  });
});
