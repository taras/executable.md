/**
 * Tier WXP — what an export leaves on disk when a step fails.
 *
 * Publication and cleanup are filesystem races. Neither reproduces by waiting,
 * so each is made to fail through the operations `exportArtifact` accepts —
 * plain functions, defaulting to the real ones, passed in rather than resolved
 * through a name anything could rebind.
 *
 * Every case records which of those operations were actually reached and
 * asserts that first. An export that refused early leaves no target and no
 * staging state too, so filesystem state on its own says nothing about whether
 * publication was ever attempted: a suite that only looked at the directory
 * would pass against a build where export never got that far.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensureDir, exists, readdir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { ensure, type Operation, scoped, until } from "effection";
import { randomUUID } from "node:crypto";
import { link } from "node:fs/promises";
import process from "node:process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runCli } from "@executablemd/test-support/launch";
import { useWorkflowLifecycle, useWorkflowRunStorage } from "@executablemd/workflow/deno";
import { exportArtifact, type ExportFilesystem } from "../src/workflow-management.ts";
import { readDefinitionSource } from "../src/workflow-source.ts";

const RELEASE = ["# Release", "", "nothing to see here", ""].join("\n");
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

interface Fixture {
  readonly repository: string;
  readonly runs: string;
  readonly home: string;
}

function* git(repository: string, args: string[]): Operation<void> {
  const result = yield* exec("git", { arguments: args, cwd: repository }).expect();
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

/**
 * A committed repository with one completed run in it.
 *
 * Started through the real CLI, so what these tests export is a run some
 * execution actually produced rather than rows a fixture wrote.
 */
function useExportedRun<T>(body: (fixture: Fixture) => Operation<T>): Operation<T> {
  return scoped(function* () {
    const root = join(tmpdir(), `xmd-wxp-${randomUUID()}`);
    const fixture: Fixture = {
      repository: join(root, "repository"),
      runs: join(root, "runs"),
      home: join(root, "home"),
    };
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    yield* ensureDir(join(fixture.repository, "flows"));
    yield* ensureDir(fixture.home);
    yield* writeTextFile(join(fixture.repository, "flows/release.md"), RELEASE);

    yield* git(fixture.repository, ["init", "-q", "--initial-branch=main", "."]);
    yield* git(fixture.repository, ["config", "user.email", "tier-wxp@example.test"]);
    yield* git(fixture.repository, ["config", "user.name", "Tier WXP"]);
    yield* git(fixture.repository, ["add", "-A"]);
    yield* git(fixture.repository, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "definition",
    ]);

    const started = yield* runCli(["workflow", "start", "--id=release-1", "flows/release.md"], {
      cwd: fixture.repository,
      env: { HOME: fixture.home, XMD_WORKFLOW_RUNS: fixture.runs },
    }).join();
    if (started.code !== 0) {
      throw new Error(`the fixture run did not start: ${started.stderr}`);
    }
    // Named here rather than discovered as an empty export later: a fixture
    // whose run landed somewhere else would make every case below refuse for a
    // reason that has nothing to do with what it is testing.
    const stored = yield* readdir(fixture.runs);
    if (stored.length === 0) {
      throw new Error(`the fixture run was not stored under ${fixture.runs}: ${started.stderr}`);
    }

    return yield* body(fixture);
  });
}

/**
 * The host this package installs, pointed at the fixture's runs.
 *
 * Run from inside the repository, because reading a retained definition back
 * means opening the checkout that run recorded.
 */
function withHost<T>(fixture: Fixture, body: () => Operation<T>): Operation<T> {
  return scoped(function* () {
    const previous = process.cwd();
    process.chdir(fixture.repository);
    yield* ensure(() => {
      process.chdir(previous);
    });
    yield* useWorkflowRunStorage({ root: fixture.runs });
    yield* useWorkflowLifecycle({ root: fixture.runs, definitionSource: readDefinitionSource });
    return yield* body();
  });
}

/** The real operations, each recording that it was reached. */
function recording(overrides: Partial<ExportFilesystem> = {}): {
  readonly log: string[];
  readonly filesystem: ExportFilesystem;
} {
  const log: string[] = [];
  const real: ExportFilesystem = {
    *link(staging: string, output: string): Operation<void> {
      log.push("link");
      yield* until(link(staging, output));
    },
    *remove(directory: string): Operation<void> {
      log.push("remove");
      yield* rm(directory, { recursive: true, force: true });
    },
    *unlink(target: string): Operation<void> {
      log.push("unlink");
      yield* rm(target, { force: true });
    },
  };
  const filesystem: ExportFilesystem = { ...real };
  for (const step of Object.keys(overrides) as (keyof ExportFilesystem)[]) {
    const replacement = overrides[step];
    if (replacement !== undefined) {
      Object.defineProperty(filesystem, step, {
        value: function* (...args: [string, string]): Operation<void> {
          log.push(step);
          yield* replacement(...args);
        },
        enumerable: true,
      });
    }
  }
  return { log, filesystem };
}

/** Whatever staging the export could have left in the publishing directory. */
function* leftovers(fixture: Fixture): Operation<string[]> {
  return (yield* readdir(fixture.repository)).filter((name) => name.startsWith(".xmd-export-"));
}

describe("Tier WXP — what an export leaves behind", () => {
  it("WXP1: a racing target is refused by link and survives byte-identical", function* () {
    yield* useExportedRun(function* (fixture) {
      const target = join(fixture.repository, "raced.xmd");
      const racer = "somebody else got here first\n";

      const recorder = recording({
        // The name is taken between validation and publication. The real link
        // then refuses, which is the whole reason publication uses one.
        *link(staging: string, output: string): Operation<void> {
          yield* writeTextFile(output, racer);
          yield* until(link(staging, output));
        },
      });
      const outcome = yield* withHost(fixture, function* () {
        return yield* exportArtifact("release-1", target, recorder.filesystem);
      });

      // Reached publication: without this the assertions below would pass
      // against an export that refused long before it got here.
      expect(recorder.log).toContain("link");
      expect(outcome.exitCode).toBe(1);
      expect(yield* readTextFile(target)).toBe(racer);
      expect(yield* leftovers(fixture)).toEqual([]);
    });
  });

  it("WXP2: a publication failure reports nothing and removes staging", function* () {
    yield* useExportedRun(function* (fixture) {
      const target = join(fixture.repository, "unpublished.xmd");

      const recorder = recording({
        // deno-lint-ignore require-yield
        *link(): Operation<void> {
          throw new Error("the link step was made to fail");
        },
      });
      const outcome = yield* withHost(fixture, function* () {
        return yield* exportArtifact("release-1", target, recorder.filesystem);
      });

      expect(recorder.log).toEqual(["link"]);
      expect(outcome.exitCode).toBe(1);
      expect(yield* exists(target)).toBe(false);
      expect(yield* leftovers(fixture)).toEqual([]);
    });
  });

  it("WXP3: a cleanup failure rolls the published target back", function* () {
    yield* useExportedRun(function* (fixture) {
      const target = join(fixture.repository, "uncleaned.xmd");

      const recorder = recording({
        // deno-lint-ignore require-yield
        *remove(): Operation<void> {
          throw new Error("the remove step was made to fail");
        },
      });
      const outcome = yield* withHost(fixture, function* () {
        return yield* exportArtifact("release-1", target, recorder.filesystem);
      });

      // The order is the claim: the artifact really was published, cleanup
      // really did fail, and the target really was taken back afterwards.
      expect(recorder.log).toEqual(["link", "remove", "unlink"]);
      expect(outcome.exitCode).toBe(1);
      expect(yield* exists(target)).toBe(false);
    });
  });

  it("WXP4: a cancellation after staging leaves neither target nor staging", function* () {
    yield* useExportedRun(function* (fixture) {
      const target = join(fixture.repository, "cancelled.xmd");
      const staged: string[] = [];

      const recorder = recording({
        *link(_staging: string, _output: string): Operation<void> {
          // Staging exists by now: record what is on disk, then end the export
          // the way a cancellation ends it — without publishing.
          staged.push(...(yield* leftovers(fixture)));
          throw new Error("cancelled before publication completed");
        },
      });
      const outcome = yield* withHost(fixture, function* () {
        return yield* exportArtifact("release-1", target, recorder.filesystem);
      });

      // Staging was really there when the export was interrupted, and the
      // scope that owned it removed it on the way out.
      expect(recorder.log).toEqual(["link"]);
      expect(staged.length).toBe(1);
      expect(outcome.exitCode).toBe(1);
      expect(yield* exists(target)).toBe(false);
      expect(yield* leftovers(fixture)).toEqual([]);
    });
  });
});
