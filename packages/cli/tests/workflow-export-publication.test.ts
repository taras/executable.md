/**
 * Tier WXP — what an export leaves on disk, on each side of its commit point.
 *
 * Publication is a filesystem race. It does not reproduce by waiting, so each
 * step is made to fail through the operations `exportArtifact` accepts — plain
 * functions, defaulting to the real ones, passed in rather than resolved
 * through a name anything could rebind.
 *
 * Every case records which of those operations were actually reached and
 * asserts that first. An export that refused early leaves no target and no
 * staging state too, so filesystem state on its own says nothing about whether
 * publication was ever attempted: a suite that only looked at the directory
 * would pass against a build where export never got that far.
 *
 * The line these cases are drawn around is the link. **Before it**, every
 * failure and the cancellation leave no file where the caller asked for one.
 * **After it**, the export has happened: a failed cleanup of the private entry
 * is a warning beside a success, and nothing takes the caller's file back. The
 * last case asserts that directly — no step is ever pointed at the requested
 * output once it exists.
 *
 * The cancellation is a cancellation. The export runs in a task of its own, a
 * pre-publication step suspends and never returns, and the test halts the task
 * — so what unwinds is Effection tearing a live scope down, reaching the
 * staging resource's own backstop. A thrown error would take a caught branch
 * instead and prove something else, which is why that case asserts nothing was
 * written to either channel.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensureDir, exists, readdir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { ensure, type Operation, scoped, spawn, suspend, until, withResolvers } from "effection";
import { randomUUID } from "node:crypto";
import { linkSync, rmSync } from "node:fs";
import { rename } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import process from "node:process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "@executablemd/test-support/launch";
import { useWorkflowLifecycle, useWorkflowRunStorage } from "@executablemd/workflow/deno";
import { exportArtifact, type ExportFilesystem } from "../src/workflow-management.ts";
import { readDefinitionSource } from "../src/workflow-source.ts";

const RELEASE = ["# Release", "", "nothing to see here", ""].join("\n");

/** What every SQLite file begins with, so "a real artifact" is not an existence check. */
const XMD_ARTIFACT_HEADER = "SQLite format 3";

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

/** One filesystem step an export took, and what it was aimed at. */
interface Step {
  readonly step: keyof ExportFilesystem;
  readonly target: string;
}

interface Recorder {
  /** The steps that were reached, in order. */
  readonly log: string[];
  /** Each step with the path it acted on, so a claim can name the path too. */
  readonly steps: Step[];
  readonly filesystem: ExportFilesystem;
}

/** The real operations, each recording that it was reached and on what. */
function recording(overrides: Partial<ExportFilesystem> = {}): Recorder {
  const log: string[] = [];
  const steps: Step[] = [];
  const real: ExportFilesystem = {
    *reserve(staging: string, hidden: string): Operation<void> {
      yield* until(rename(staging, hidden));
    },
    *remove(directory: string): Operation<void> {
      yield* rm(directory, { recursive: true, force: true });
    },
    link(hidden: string, output: string): void {
      // Synchronous because the interface is, and the interface is because
      // publication is the commit point: nothing may suspend between the entry
      // appearing and the export recording that it did.
      // oxlint-disable-next-line local/no-sync-filesystem
      linkSync(hidden, output);
    },
    unlink(hidden: string): void {
      // Synchronous for the same reason: this runs after the commit, and
      // nothing may suspend between it and the outcome the command reports.
      // oxlint-disable-next-line local/no-sync-filesystem
      rmSync(hidden, { force: true });
    },
  };
  const filesystem: ExportFilesystem = { ...real };
  for (const step of Object.keys(real) as (keyof ExportFilesystem)[]) {
    const replacement = overrides[step] ?? real[step];
    Object.defineProperty(filesystem, step, {
      // The recording happens for every step, replaced or not: which operations
      // ran is the first thing each case asserts, and a log that only covered
      // the substituted ones could not say what order the rest went in.
      value: function (...args: [string, string]) {
        log.push(step);
        // The second argument for `link`, which acts on the destination, and
        // the first for everything else, which acts on private state.
        steps.push({ step, target: step === "link" ? (args[1] ?? "") : (args[0] ?? "") });
        return (replacement as (...given: [string, string]) => unknown)(...args);
      },
      enumerable: true,
    });
  }
  return { log, steps, filesystem };
}

/** Whatever staging the export could have left in the publishing directory. */
function* leftovers(fixture: Fixture): Operation<string[]> {
  return (yield* readdir(fixture.repository)).filter((name) => name.startsWith(".xmd-export-"));
}

/** Every path this export asked a filesystem step to act on. */
function targets(recorder: Recorder): string[] {
  return recorder.steps.map((step) => step.target);
}

/**
 * Every path this export asked to have removed.
 *
 * `link` is the one step that creates rather than removes, so a rollback of a
 * committed output could only appear here.
 */
function removals(recorder: Recorder): string[] {
  return recorder.steps.filter((step) => step.step !== "link").map((step) => step.target);
}

/** The two channels an export writes to, captured for the length of one case. */
function* capturing(said: { out: string[]; err: string[] }): Operation<void> {
  const log = console.log;
  const error = console.error;
  yield* ensure(() => {
    console.log = log;
    console.error = error;
  });
  console.log = (...parts: unknown[]) => said.out.push(parts.map(String).join(" "));
  console.error = (...parts: unknown[]) => said.err.push(parts.map(String).join(" "));
}

describe("Tier WXP — what an export leaves behind", () => {
  it("WXP1: a racing target is refused by link and survives byte-identical", function* () {
    yield* useExportedRun(function* (fixture) {
      const target = join(fixture.repository, "raced.xmd");
      const racer = "somebody else got here first\n";

      const recorder = recording({
        // The name is taken between the early check and publication. The real
        // link then refuses, which is the whole reason publication uses one.
        link(hidden: string, output: string): void {
          // Both synchronous because this stands in for the commit point, whose
          // whole property is that nothing suspends inside it.
          // oxlint-disable-next-line local/no-sync-filesystem
          writeFileSync(output, racer);
          // oxlint-disable-next-line local/no-sync-filesystem
          linkSync(hidden, output);
        },
      });
      const outcome = yield* withHost(fixture, function* () {
        return yield* exportArtifact("release-1", target, recorder.filesystem);
      });

      // Reached publication, after everything private was already finished:
      // without this the assertions below would pass against an export that
      // refused long before it got here.
      expect(recorder.log).toEqual(["reserve", "remove", "link"]);
      expect(outcome.exitCode).toBe(1);
      expect(yield* readTextFile(target)).toBe(racer);
      expect(yield* leftovers(fixture)).toEqual([]);
    });
  });

  it("WXP2: a publication failure reports nothing and leaves no target", function* () {
    yield* useExportedRun(function* (fixture) {
      const target = join(fixture.repository, "unpublished.xmd");

      const recorder = recording({
        link(): void {
          throw new Error("the link step was made to fail");
        },
      });
      const outcome = yield* withHost(fixture, function* () {
        return yield* exportArtifact("release-1", target, recorder.filesystem);
      });

      expect(recorder.log).toEqual(["reserve", "remove", "link"]);
      expect(outcome.exitCode).toBe(1);
      expect(yield* exists(target)).toBe(false);
      expect(yield* leftovers(fixture)).toEqual([]);
    });
  });

  it("WXP3: a cleanup failure before publication publishes nothing at all", function* () {
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

      // The order is the claim: every temporary is dealt with before the
      // destination is touched, so a cleanup that fails stops the export
      // rather than leaving it to be taken back afterwards. `link` never ran.
      expect(recorder.log).toEqual(["reserve", "remove"]);
      expect(outcome.exitCode).toBe(1);
      expect(yield* exists(target)).toBe(false);
      expect(yield* leftovers(fixture)).toEqual([]);
    });
  });

  it("WXP4: halting a live export before it commits publishes nothing", function* () {
    yield* useExportedRun(function* (fixture) {
      const target = join(fixture.repository, "cancelled.xmd");
      // The artifact is finished and staging is on disk. Nothing resolves this
      // suspend, so the only thing that can end the export is the halt below —
      // which is what makes this a cancellation rather than a thrown error
      // wearing the word.
      const staging = withResolvers<string[]>();
      const recorder = recording({
        *reserve(): Operation<void> {
          // Taken while it is still there. After the halt there is nothing left
          // to learn the names from, so a case that looked afterwards could not
          // tell removed state from state that was never created.
          staging.resolve(yield* leftovers(fixture));
          yield* suspend();
        },
      });

      // Both channels, because the two ways this could pass for the wrong
      // reason are a success line and a refusal. A halt produces neither.
      const said = { out: [] as string[], err: [] as string[] };
      yield* capturing(said);

      const exporting = yield* spawn(function* () {
        return yield* withHost(fixture, function* () {
          return yield* exportArtifact("release-1", target, recorder.filesystem);
        });
      });

      const present = yield* staging.operation;
      expect(recorder.log).toEqual(["reserve"]);
      expect(present).toHaveLength(1);

      yield* exporting.halt();

      // Nothing further ran, nothing was published, and the scope that owned
      // the private state took it with it.
      expect(recorder.log).toEqual(["reserve"]);
      expect(yield* exists(target)).toBe(false);
      expect(yield* leftovers(fixture)).toEqual([]);
      expect([...said.out, ...said.err]).toEqual([]);
    });
  });

  it("WXP5: a cleanup failure after publication keeps the artifact and warns", function* () {
    yield* useExportedRun(function* (fixture) {
      const target = join(fixture.repository, "published.xmd");

      const recorder = recording({
        unlink(): void {
          throw new Error("the unlink step was made to fail");
        },
      });
      const said = { out: [] as string[], err: [] as string[] };
      yield* capturing(said);

      const outcome = yield* withHost(fixture, function* () {
        return yield* exportArtifact("release-1", target, recorder.filesystem);
      });

      // Published, and then cleanup failed — the double failure this contract
      // used to answer by taking the caller's file back.
      expect(recorder.log).toEqual(["reserve", "remove", "link", "unlink"]);
      expect(outcome.exitCode).toBe(0);

      // The artifact is there and it is the real thing, not a placeholder.
      expect(yield* exists(target)).toBe(true);
      expect(yield* readTextFile(join(fixture.repository, "published.xmd"))).toContain(
        XMD_ARTIFACT_HEADER,
      );

      // Success is reported, and nothing claims a failure.
      expect(said.out.join("\n")).toContain(`workflow artifact: ${target}`);
      expect(said.out.join("\n")).toContain("workflow artifact identity: ");
      expect(said.err.join("\n")).not.toContain("Nothing was published");
      expect(said.err.join("\n")).not.toContain("will not replace");

      // The warning names the private entry that was left, and only that.
      const retained = yield* leftovers(fixture);
      expect(retained).toHaveLength(1);
      expect(said.err.join("\n")).toContain(retained[0] ?? "<none>");
      expect(said.err.join("\n")).toContain("The artifact is complete");

      // The committed output is never a target of a removal — not by the
      // cleanup that failed, and not by anything after it. `link` names it
      // once, which is the commit, and nothing else names it at all.
      expect(removals(recorder).filter((path) => path === target)).toEqual([]);
      expect(targets(recorder).filter((path) => path === target)).toEqual([target]);
    });
  });

  it("WXP6: nothing an export does is ever aimed at removing its committed output", function* () {
    yield* useExportedRun(function* (fixture) {
      const target = join(fixture.repository, "committed.xmd");
      const recorder = recording();
      const said = { out: [] as string[], err: [] as string[] };
      yield* capturing(said);

      const outcome = yield* withHost(fixture, function* () {
        return yield* exportArtifact("release-1", target, recorder.filesystem);
      });

      expect(outcome.exitCode).toBe(0);
      expect(recorder.log).toEqual(["reserve", "remove", "link", "unlink"]);

      // `link` is the only step that names the destination at all; every other
      // one acts on private state. A rollback would show up here as a second
      // appearance of the target, under a step that removes.
      expect(recorder.steps.filter((step) => step.target === target)).toEqual([
        { step: "link", target },
      ]);
      expect(yield* exists(target)).toBe(true);
      expect(yield* leftovers(fixture)).toEqual([]);
      expect(said.err).toEqual([]);
    });
  });
});
