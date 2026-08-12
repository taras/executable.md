/**
 * Tier WFC — `xmd workflow start` and `xmd workflow resume`.
 *
 * Every run here shells out, so exit status, the two stderr metadata lines and
 * the document's own stdout are observed exactly as a caller sees them. Each
 * fixture is a real Git repository in a temporary directory with a real commit,
 * because what the definition *is* comes from Git, and each run store is an
 * isolated absolute directory named by `XMD_WORKFLOW_RUNS` — nothing here goes
 * near `~/.xmd`.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import { ensureDir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "@executablemd/test-support/launch";
import { workflowRunPath } from "@executablemd/workflow/deno";

interface Fixture {
  /** The repository the definition lives in. */
  readonly repository: string;
  /** The isolated run store. */
  readonly runs: string;
  /** An isolated HOME, so nothing reaches the developer's own configuration. */
  readonly home: string;
}

const RELEASE = [
  "---",
  "props:",
  "  channel:",
  "    type: string",
  "    default: stable",
  "---",
  "",
  "# Release",
  "",
  '<File path="notes.md">channel={props.channel}</File>',
  "",
  '<File path="notes.md" as="notes" />',
  "",
  "Wrote: {notes}",
  "",
].join("\n");

/**
 * A document that fails.
 *
 * A `<File>` refusal is a *printed* error — data, and the run still completes —
 * so a failed run needs an error nothing recovers. The unresolvable component
 * is one, and it doubles as the evidence for the other claim this fixture
 * carries: a workflow definition is one immutable object, so the component
 * search path is empty and a repository component fails to resolve rather than
 * resolving to content beside the definition in a mutable checkout.
 */
const REFUSING = ["# Refusing", "", "<ComponentBesideTheDefinition />", ""].join("\n");

function* git(repository: string, args: string[]): Operation<void> {
  const result = yield* exec("git", { arguments: args, cwd: repository }).expect();
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

/** A committed repository, an empty run store, and an isolated HOME. */
function useFixture<T>(
  files: Record<string, string>,
  body: (fixture: Fixture) => Operation<T>,
): Operation<T> {
  return scoped(function* () {
    const root = join(tmpdir(), `xmd-wfc-${randomUUID()}`);
    const fixture: Fixture = {
      repository: join(root, "repository"),
      runs: join(root, "runs"),
      home: join(root, "home"),
    };
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    yield* ensureDir(fixture.repository);
    yield* ensureDir(fixture.home);

    for (const [name, content] of Object.entries(files)) {
      const path = join(fixture.repository, name);
      yield* ensureDir(join(path, ".."));
      yield* writeTextFile(path, content);
    }

    yield* git(fixture.repository, ["init", "-q", "--initial-branch=main", "."]);
    yield* git(fixture.repository, ["config", "user.email", "tier-wfc@example.test"]);
    yield* git(fixture.repository, ["config", "user.name", "Tier WFC"]);
    yield* git(fixture.repository, ["add", "-A"]);
    yield* git(fixture.repository, ["commit", "-q", "-m", "definition"]);

    return yield* body(fixture);
  });
}

function xmd(fixture: Fixture, args: string[]) {
  return runCli(args, {
    cwd: fixture.repository,
    env: { HOME: fixture.home, XMD_WORKFLOW_RUNS: fixture.runs },
  });
}

/** The run id the `workflow run:` line reported. */
function reportedRunId(stderr: string): string | undefined {
  const line = stderr.split("\n").find((entry) => entry.startsWith("workflow run: "));
  return line?.slice("workflow run: ".length).trim();
}

/** The status the `workflow status:` line reported. */
function reportedStatus(stderr: string): string | undefined {
  const line = stderr.split("\n").find((entry) => entry.startsWith("workflow status: "));
  return line?.slice("workflow status: ".length).trim();
}

describe("Tier WFC — xmd workflow start and resume", () => {
  it("WFC1: two starts without an id make two runs", function* () {
    yield* useFixture({ "flows/release.md": RELEASE }, function* (fixture) {
      const first = yield* xmd(fixture, ["workflow", "start", "flows/release.md"]).join();
      const second = yield* xmd(fixture, ["workflow", "start", "flows/release.md"]).join();

      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      expect(reportedStatus(first.stderr)).toBe("completed");

      const one = reportedRunId(first.stderr);
      const other = reportedRunId(second.stderr);
      expect(one).toBeDefined();
      expect(other).toBeDefined();
      expect(one).not.toBe(other);
      expect(first.stdout).toContain("Wrote: channel=stable");
    });
  });

  it("WFC2: reusing an id compatibly finds the run, and incompatibly is refused", function* () {
    yield* useFixture({ "flows/release.md": RELEASE }, function* (fixture) {
      const created = yield* xmd(fixture, [
        "workflow",
        "start",
        "--id=release-1",
        "flows/release.md",
      ]).join();
      expect(created.code).toBe(0);
      expect(reportedRunId(created.stderr)).toBe("release-1");

      const reused = yield* xmd(fixture, [
        "workflow",
        "start",
        "--id=release-1",
        "flows/release.md",
      ]).join();
      expect(reused.code).toBe(0);
      expect(reportedRunId(reused.stderr)).toBe("release-1");

      const conflicting = yield* xmd(fixture, [
        "workflow",
        "start",
        "--id=release-1",
        "flows/release.md",
        "--props-channel=beta",
      ]).join();
      expect(conflicting.code).toBe(1);
      expect(conflicting.stderr).toContain("release-1");
      expect(conflicting.stderr).toContain("props");
      // A refused reuse creates nothing: the run that is there is the one that
      // was there, still reporting the props it was created with.
      expect(reportedStatus(conflicting.stderr)).toBeUndefined();

      const unchanged = yield* xmd(fixture, ["workflow", "resume", "release-1"]).join();
      expect(unchanged.stdout).toContain("Wrote: channel=stable");
    });
  });

  it("WFC3: generated prop arguments belong to start alone", function* () {
    yield* useFixture({ "flows/release.md": RELEASE }, function* (fixture) {
      const started = yield* xmd(fixture, [
        "workflow",
        "start",
        "--id=props-1",
        "flows/release.md",
        "--props-channel=beta",
      ]).join();
      expect(started.code).toBe(0);
      expect(started.stdout).toContain("Wrote: channel=beta");

      const help = yield* xmd(fixture, ["workflow", "start", "flows/release.md", "--help"]).join();
      expect(help.code).toBe(0);
      expect(help.stdout).toContain("--props-channel");

      const refused = yield* xmd(fixture, [
        "workflow",
        "resume",
        "props-1",
        "--props-channel=stable",
      ]).join();
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("--props-channel");
      expect(reportedStatus(refused.stderr)).toBeUndefined();

      const aggregate = yield* xmd(fixture, [
        "workflow",
        "resume",
        "props-1",
        "--props",
        '{"channel":"stable"}',
      ]).join();
      expect(aggregate.code).toBe(1);
    });
  });

  it("WFC4: the definition is the committed object, not the working tree", function* () {
    yield* useFixture({ "flows/release.md": RELEASE }, function* (fixture) {
      yield* writeTextFile(
        join(fixture.repository, "flows/release.md"),
        `${RELEASE}\nUNCOMMITTED\n`,
      );

      const started = yield* xmd(fixture, [
        "workflow",
        "start",
        "--id=pinned-1",
        "flows/release.md",
      ]).join();

      expect(started.code).toBe(0);
      expect(started.stdout).toContain("Wrote: channel=stable");
      expect(started.stdout).not.toContain("UNCOMMITTED");
    });
  });

  it("WFC5: resume names only a run, and finds its definition again", function* () {
    yield* useFixture({ "flows/release.md": RELEASE }, function* (fixture) {
      yield* xmd(fixture, ["workflow", "start", "--id=resume-1", "flows/release.md"]).expect();

      const resumed = yield* xmd(fixture, ["workflow", "resume", "resume-1"]).join();
      expect(resumed.code).toBe(0);
      expect(reportedRunId(resumed.stderr)).toBe("resume-1");
      expect(resumed.stdout).toContain("Wrote: channel=stable");

      const withDocument = yield* xmd(fixture, [
        "workflow",
        "resume",
        "resume-1",
        "flows/release.md",
      ]).join();
      expect(withDocument.code).toBe(1);
    });
  });

  it("WFC6: a failing document reports failed and exits 1, and replays as failed", function* () {
    yield* useFixture(
      {
        "flows/refusing.md": REFUSING,
        "components/ComponentBesideTheDefinition.md": "resolved from the checkout\n",
      },
      function* (fixture) {
        const failed = yield* xmd(fixture, [
          "workflow",
          "start",
          "--id=failing-1",
          "flows/refusing.md",
        ]).join();
        expect(failed.code).toBe(1);
        expect(reportedStatus(failed.stderr)).toBe("failed");
        // Nothing beside the definition was searched, so nothing beside it could
        // have been read.
        expect(failed.stderr).toContain("ComponentBesideTheDefinition");
        expect(failed.stderr).toContain("searched: ");

        // A compatible reuse of retained failed history replays that failure
        // rather than retrying the work.
        const replayed = yield* xmd(fixture, [
          "workflow",
          "start",
          "--id=failing-1",
          "flows/refusing.md",
        ]).join();
        expect(replayed.code).toBe(1);
        expect(reportedStatus(replayed.stderr)).toBe("failed");
        expect(replayed.stdout).not.toContain("resolved from the checkout");
      },
    );
  });

  it("WFC7: absent, foreign and unreadable storage is reported and left alone", function* () {
    yield* useFixture({ "flows/release.md": RELEASE }, function* (fixture) {
      const missing = yield* xmd(fixture, ["workflow", "resume", "never-started"]).join();
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("never-started");
      expect(reportedRunId(missing.stderr)).toBeUndefined();

      yield* xmd(fixture, ["workflow", "start", "--id=corrupt-1", "flows/release.md"]).expect();
      const runPath = workflowRunPath(fixture.runs, "corrupt-1");
      const before = yield* readTextFile(runPath);
      yield* writeTextFile(runPath, "this is not a workflow run database");

      const corrupt = yield* xmd(fixture, ["workflow", "resume", "corrupt-1"]).join();
      expect(corrupt.code).toBe(1);
      expect(reportedStatus(corrupt.stderr)).toBeUndefined();
      // Described, never replaced: the bytes are exactly what the test wrote.
      expect(yield* readTextFile(runPath)).toBe("this is not a workflow run database");
      expect(before).not.toBe("this is not a workflow run database");
    });
  });

  it("WFC8: the grammar refuses what the command does not have", function* () {
    yield* useFixture({ "flows/release.md": RELEASE }, function* (fixture) {
      const noAction = yield* xmd(fixture, ["workflow"]).join();
      expect(noAction.code).toBe(1);
      expect(noAction.stderr).toContain("start");

      const unknown = yield* xmd(fixture, ["workflow", "cancel", "release-1"]).join();
      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toContain("cancel");

      const noTarget = yield* xmd(fixture, ["workflow", "start"]).join();
      expect(noTarget.code).toBe(1);

      const resumeId = yield* xmd(fixture, [
        "workflow",
        "resume",
        "release-1",
        "--id=other",
      ]).join();
      expect(resumeId.code).toBe(1);
      expect(resumeId.stderr).toContain("--id");

      const agent = yield* xmd(fixture, [
        "workflow",
        "start",
        "flows/release.md",
        "--approve-all",
      ]).join();
      expect(agent.code).toBe(1);
      expect(agent.stderr).toContain("--approve-all");

      const inline = yield* xmd(fixture, ["workflow", "start", "-e", "# hi"]).join();
      expect(inline.code).toBe(1);
    });
  });

  it("WFC11: `--` ends the options, not the grammar", function* () {
    yield* useFixture({ "flows/release.md": RELEASE }, function* (fixture) {
      // A third argument is a third argument however it is written. Before this,
      // `--` ended the check rather than the options, so these reached storage.
      const extraResume = yield* xmd(fixture, [
        "workflow",
        "resume",
        "release-1",
        "--",
        "unexpected.md",
      ]).join();
      expect(extraResume.code).toBe(1);
      // The grammar refused it — not storage, not Git, and not a missing run.
      expect(extraResume.stderr).toContain("unexpected.md");
      expect(extraResume.stderr).not.toContain("workflow run:");
      expect(extraResume.stderr).not.toContain("workflow status:");

      const extraStart = yield* xmd(fixture, [
        "workflow",
        "start",
        "flows/release.md",
        "--",
        "second.md",
      ]).join();
      expect(extraStart.code).toBe(1);
      expect(extraStart.stderr).toContain("second.md");
      expect(extraStart.stderr).not.toContain("workflow run:");

      // And one valid target after `--` is still one valid target.
      const started = yield* xmd(fixture, ["workflow", "start", "--", "flows/release.md"]).join();
      expect(started.code).toBe(0);
      expect(started.stderr).toContain("workflow status: completed");
      const runId = /workflow run: (\S+)/.exec(started.stderr)?.[1];
      expect(runId).toBeDefined();

      const resumed = yield* xmd(fixture, ["workflow", "resume", "--", runId ?? ""]).join();
      expect(resumed.code).toBe(0);
      expect(resumed.stderr).toContain("workflow status: completed");
    });
  });

  it("WFC12: a dash-leading definition and run id are what `--` is for", function* () {
    yield* useFixture({ "-release.md": RELEASE }, function* (fixture) {
      // The whole point of the separator: a name that begins with `-` is a name,
      // not an option, and the parser never gets the chance to read it as one.
      const started = yield* xmd(fixture, [
        "workflow",
        "start",
        "--id=-architect-probe-run",
        "--",
        "-release.md",
      ]).join();
      expect(started.code).toBe(0);
      expect(started.stderr).toContain("workflow run: -architect-probe-run");
      expect(started.stderr).toContain("workflow status: completed");

      // A dash-leading run id resumes on the same terms.
      const resumed = yield* xmd(fixture, [
        "workflow",
        "resume",
        "--",
        "-architect-probe-run",
      ]).join();
      expect(resumed.code).toBe(0);
      expect(resumed.stderr).toContain("workflow run: -architect-probe-run");
      expect(resumed.stderr).toContain("workflow status: completed");

      // And a third positional after it is still a third positional.
      const extra = yield* xmd(fixture, [
        "workflow",
        "resume",
        "--",
        "-architect-probe-run",
        "unexpected.md",
      ]).join();
      expect(extra.code).toBe(1);
      expect(extra.stderr).toContain("unexpected.md");
      expect(extra.stderr).not.toContain("workflow run:");
      expect(extra.stderr).not.toContain("workflow status:");
    });
  });

  it("WFC9: a definition outside a repository, and one that is not Markdown", function* () {
    yield* useFixture(
      { "flows/release.md": RELEASE, "flows/root.ts": "export default 1;\n" },
      function* (fixture) {
        const notMarkdown = yield* xmd(fixture, ["workflow", "start", "flows/root.ts"]).join();
        expect(notMarkdown.code).toBe(1);
        expect(notMarkdown.stderr).toMatch(/markdown/i);
        expect(reportedRunId(notMarkdown.stderr)).toBeUndefined();

        const outside = yield* xmd(fixture, ["workflow", "start", "../elsewhere.md"]).join();
        expect(outside.code).toBe(1);
        expect(reportedRunId(outside.stderr)).toBeUndefined();
      },
    );
  });

  it("WFC10: ordinary xmd run is unchanged by any of this", function* () {
    yield* useFixture({ "flows/release.md": RELEASE }, function* (fixture) {
      const run = yield* xmd(fixture, ["run", "flows/release.md", "--props-channel=beta"]).join();
      expect(run.code).toBe(0);
      expect(run.stdout).toContain("Wrote: channel=beta");
      expect(run.stderr).not.toContain("workflow run:");
      // `xmd run` writes into the caller's own filesystem, which is exactly
      // what a workflow run does not do.
      expect(yield* readTextFile(join(fixture.repository, "notes.md"))).toBe("channel=beta");
    });
  });
});
