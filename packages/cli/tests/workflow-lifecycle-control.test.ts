/**
 * Tier WFC2 — `xmd workflow cancel` and `xmd workflow delete`.
 *
 * Shelled out, so the exit code and the two output streams are what a caller
 * sees. A management command reports its own request: cancelling a run that
 * becomes terminal is success, and only a request the command cannot answer
 * exits 1.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import { ensureDir, exists, rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "@executablemd/test-support/launch";
import { workflowRunLock, workflowRunPath } from "@executablemd/workflow/deno";

interface Fixture {
  readonly repository: string;
  readonly runs: string;
  readonly home: string;
}

const RELEASE = ["# Release", "", "Nothing but prose.", ""].join("\n");

function* git(repository: string, args: string[]): Operation<void> {
  const result = yield* exec("git", { arguments: args, cwd: repository }).expect();
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function useFixture<T>(body: (fixture: Fixture) => Operation<T>): Operation<T> {
  return scoped(function* () {
    const root = join(tmpdir(), `xmd-wfc2-${randomUUID()}`);
    const fixture: Fixture = {
      repository: join(root, "repository"),
      runs: join(root, "runs"),
      home: join(root, "home"),
    };
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    yield* ensureDir(fixture.repository);
    yield* ensureDir(fixture.home);
    yield* writeTextFile(join(fixture.repository, "flow.md"), RELEASE);

    yield* git(fixture.repository, ["init", "-q", "--initial-branch=main", "."]);
    yield* git(fixture.repository, ["config", "user.email", "tier-wfc2@example.test"]);
    yield* git(fixture.repository, ["config", "user.name", "Tier WFC2"]);
    yield* git(fixture.repository, ["add", "-A"]);
    // The fixture is not the developer's repository: whatever signing their own
    // configuration asks for is not this commit's business.
    yield* git(fixture.repository, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "definition",
    ]);

    return yield* body(fixture);
  });
}

function xmd(fixture: Fixture, args: string[]) {
  return runCli(args, {
    cwd: fixture.repository,
    env: { HOME: fixture.home, XMD_WORKFLOW_RUNS: fixture.runs },
  });
}

describe("Tier WFC2 — xmd workflow cancel and delete", () => {
  it("WFC2-1: a completed run refuses cancellation and reports its own request", function* () {
    yield* useFixture(function* (fixture) {
      yield* xmd(fixture, ["workflow", "start", "--id=release-1", "flow.md"]).expect();

      // Its outcome already won.
      const refused = yield* xmd(fixture, ["workflow", "cancel", "release-1"]).join();
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe("");
      expect(yield* status(fixture, "release-1")).toBe("completed");
    });
  });

  it("WFC2-2: cancelling a resumable run succeeds and reports the retained status", function* () {
    yield* useFixture(function* (fixture) {
      yield* xmd(fixture, ["workflow", "start", "--id=release-1", "flow.md"]).expect();
      // A run whose outcome has not won: the only way to reach one from here is
      // to take the root Close away, which is what an interrupted run looks
      // like on disk.
      yield* interrupt(fixture, "release-1");

      const cancelled = yield* xmd(fixture, ["workflow", "cancel", "release-1"]).join();
      expect(cancelled.code).toBe(0);
      expect(cancelled.stdout).toContain("workflow cancel: release-1");
      expect(cancelled.stdout).toContain("cancelled");
      expect(yield* status(fixture, "release-1")).toBe("cancelled");

      // Idempotent: asking again is the same answer, not an error.
      const again = yield* xmd(fixture, ["workflow", "cancel", "release-1"]).join();
      expect(again.code).toBe(0);
    });
  });

  it("WFC2-3: delete removes the run and says what went", function* () {
    yield* useFixture(function* (fixture) {
      yield* xmd(fixture, ["workflow", "start", "--id=release-1", "flow.md"]).expect();
      yield* xmd(fixture, ["workflow", "start", "--id=release-2", "flow.md"]).expect();

      const deleted = yield* xmd(fixture, ["workflow", "delete", "release-1"]).join();
      expect(deleted.code).toBe(0);
      expect(deleted.stdout).toContain("workflow delete: release-1");
      expect(deleted.stdout).toContain("run-storage");

      expect(yield* exists(workflowRunPath(fixture.runs, "release-1"))).toBe(false);
      // The empty lock may remain; it is host arrangement, not retained state,
      // and it is not a category the caller is told about.
      expect(deleted.stdout).not.toContain("lifecycle-control");

      // The run beside it is still there and still readable.
      expect(yield* status(fixture, "release-2")).toBe("completed");

      // Absent is an error rather than an idempotent success.
      const again = yield* xmd(fixture, ["workflow", "delete", "release-1"]).join();
      expect(again.code).toBe(1);
      expect(again.stdout).toBe("");
    });
  });

  it("WFC2-4: an absent run is refused by both, and nothing is created", function* () {
    yield* useFixture(function* (fixture) {
      for (const action of ["cancel", "delete"]) {
        const refused = yield* xmd(fixture, ["workflow", action, "never-started"]).join();
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("never-started");
      }
      expect(yield* exists(workflowRunPath(fixture.runs, "never-started"))).toBe(false);
      expect(yield* exists(workflowRunLock(fixture.runs, "never-started"))).toBe(true);
    });
  });
});

/** What `status --json` says this run retains. */
function* status(fixture: Fixture, runId: string): Operation<string> {
  const answered = yield* xmd(fixture, ["workflow", "status", runId, "--json"]).join();
  if (answered.code !== 0) {
    throw new Error(`status ${runId} failed: ${answered.stderr}`);
  }
  return JSON.parse(answered.stdout).record.status;
}

/**
 * The retained shape an interrupted run has: an outcome its root never
 * recorded. Removing the Close is the only way to reach it from here, since
 * this fixture's document cannot be made to hang.
 */
// deno-lint-ignore require-yield
function* interrupt(fixture: Fixture, runId: string): Operation<void> {
  const database = new DatabaseSync(workflowRunPath(fixture.runs, runId));
  try {
    database.exec('DELETE FROM journal_events WHERE record LIKE \'%"type":"close"%\'');
    database.exec("UPDATE workflow_run SET status = 'interrupted'");
    database.exec("UPDATE document_executions SET stop_status = 'interrupted'");
  } finally {
    database.close();
  }
}
