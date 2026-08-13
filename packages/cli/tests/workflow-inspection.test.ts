/**
 * Tier WFI — `xmd workflow status`, `list` and `history`.
 *
 * Every run here shells out, so what is observed is what a caller sees: the
 * answer on standard output, diagnostics on standard error, and an exit code
 * that describes the request rather than the run. A completed run and a failed
 * run both report successfully; only a request the command cannot answer
 * exits 1.
 *
 * The fixture is a real Git repository and an isolated run store, because a
 * definition is what Git holds and a run is a real file. Nothing here goes near
 * `~/.xmd`.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "@executablemd/test-support/launch";
import { workflowRunPath } from "@executablemd/workflow/deno";

interface Fixture {
  readonly repository: string;
  readonly runs: string;
  readonly home: string;
}

const RELEASE = [
  "# Release",
  "",
  '<File path="notes.md">written</File>',
  "",
  "```bash exec",
  "echo hi",
  "```",
  "",
].join("\n");

/** A document that fails, so a failed run can be listed beside a completed one. */
const REFUSING = ["# Refusing", "", "<Output>", "", "<Missing />", "", "</Output>", ""].join("\n");

function* git(repository: string, args: string[]): Operation<void> {
  const result = yield* exec("git", { arguments: args, cwd: repository }).expect();
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function useFixture<T>(
  files: Record<string, string>,
  body: (fixture: Fixture) => Operation<T>,
): Operation<T> {
  return scoped(function* () {
    const root = join(tmpdir(), `xmd-wfi-${randomUUID()}`);
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
    yield* git(fixture.repository, ["config", "user.email", "tier-wfi@example.test"]);
    yield* git(fixture.repository, ["config", "user.name", "Tier WFI"]);
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

/** Bytes and mode together: what a read must leave exactly as it found it. */
function fingerprint(path: string): string {
  return `${readFileSync(path).toString("base64")}:${statSync(path).mode}`;
}

interface HistoryRow {
  readonly eventId: string;
  readonly event: { readonly type: string; readonly description?: { readonly type: string } };
  readonly workspaceRootId: string;
  readonly source?: { readonly path?: string; readonly line: number; readonly column: number };
}

describe("Tier WFI — xmd workflow status, list and history", () => {
  it("WFI1: status reports one run, and --json is the same answer structurally", function* () {
    yield* useFixture({ "flows/release.md": RELEASE }, function* (fixture) {
      yield* xmd(fixture, ["workflow", "start", "--id=release-1", "flows/release.md"]).expect();

      const human = yield* xmd(fixture, ["workflow", "status", "release-1"]).join();
      expect(human.code).toBe(0);
      expect(human.stdout).toContain("run: release-1");
      expect(human.stdout).toContain("status: completed");
      expect(human.stdout).toContain("flows/release.md");
      expect(human.stdout).toContain("executions: 1");

      const structured = yield* xmd(fixture, ["workflow", "status", "release-1", "--json"]).join();
      expect(structured.code).toBe(0);
      // One object and the newline that ends it.
      expect(structured.stdout.endsWith("\n")).toBe(true);
      const snapshot = JSON.parse(structured.stdout);
      expect(snapshot.record.runId).toBe("release-1");
      expect(snapshot.record.status).toBe("completed");
      expect(snapshot.executions).toHaveLength(1);
      expect(typeof snapshot.currentWorkspaceRootId).toBe("string");
      expect(typeof snapshot.journalFrontier.eventId).toBe("string");
    });
  });

  it("WFI2: list reports every run newest first and filters by one exact status", function* () {
    yield* useFixture(
      { "flows/release.md": RELEASE, "flows/refusing.md": REFUSING },
      function* (fixture) {
        yield* xmd(fixture, ["workflow", "start", "--id=done-1", "flows/release.md"]).expect();
        const failed = yield* xmd(fixture, [
          "workflow",
          "start",
          "--id=failed-1",
          "flows/refusing.md",
        ]).join();
        expect(failed.code).toBe(1);

        const listed = yield* xmd(fixture, ["workflow", "list", "--json"]).join();
        expect(listed.code).toBe(0);
        const snapshots = JSON.parse(listed.stdout);
        expect(
          snapshots.map((snapshot: { record: { runId: string } }) => snapshot.record.runId),
        ).toEqual(["failed-1", "done-1"]);

        const filtered = yield* xmd(fixture, [
          "workflow",
          "list",
          "--status=completed",
          "--json",
        ]).join();
        expect(filtered.code).toBe(0);
        expect(
          JSON.parse(filtered.stdout).map(
            (snapshot: { record: { runId: string } }) => snapshot.record.runId,
          ),
        ).toEqual(["done-1"]);

        const human = yield* xmd(fixture, ["workflow", "list"]).join();
        expect(human.code).toBe(0);
        expect(human.stdout).toContain("RUN");
        expect(human.stdout).toContain("failed-1");
        expect(human.stdout).toContain("done-1");
      },
    );
  });

  it("WFI3: history JSON holds every retained event, its root and its authored source", function* () {
    yield* useFixture({ "flows/release.md": RELEASE }, function* (fixture) {
      yield* xmd(fixture, ["workflow", "start", "--id=release-1", "flows/release.md"]).expect();

      const structured = yield* xmd(fixture, ["workflow", "history", "release-1", "--json"]).join();
      expect(structured.code).toBe(0);
      const entries: HistoryRow[] = JSON.parse(structured.stdout);

      // Every row carries its own id and the root it was written against.
      expect(entries.length).toBeGreaterThan(2);
      for (const entry of entries) {
        expect(typeof entry.eventId).toBe("string");
        expect(entry.workspaceRootId).toMatch(/^[0-9a-f]{64}$/);
      }

      // The command block was written on the fifth line of the definition, and
      // history says so from what the event retained.
      const command = entries.find((entry) => entry.event.description?.type === "exec");
      expect(command?.source).toEqual({
        path: "flows/release.md",
        offset: RELEASE.indexOf("```bash exec"),
        line: 5,
        column: 1,
      });

      // A Workspace file effect is authored the same way, and says where.
      const file = entries.find((entry) => entry.event.description?.type === "workspace_file");
      expect(file?.source).toEqual({
        path: "flows/release.md",
        offset: RELEASE.indexOf("<File"),
        line: 3,
        column: 1,
      });

      // The root's own entry is not an authored element and claims no position.
      const root = entries.find((entry) => entry.event.description?.type === "workflow_run");
      expect(root?.source).toBeUndefined();

      const human = yield* xmd(fixture, ["workflow", "history", "release-1"]).join();
      expect(human.code).toBe(0);
      expect(human.stdout).toContain("EVENT");
      expect(human.stdout).toContain("flows/release.md:5:1");
      // The root Close is the outcome footer rather than one more operation row.
      expect(human.stdout).toContain("Outcome: completed at");
    });
  });

  it("WFI4: a run with no root Close says so rather than inventing an outcome", function* () {
    yield* useFixture({ "flows/release.md": RELEASE }, function* (fixture) {
      yield* xmd(fixture, ["workflow", "start", "--id=partial-1", "flows/release.md"]).expect();

      // The retained shape a suspended or interrupted run has: durable events
      // and no root Close. Neither status is reachable from this slice's
      // commands, so the row is removed directly rather than left untested.
      const database = new DatabaseSync(workflowRunPath(fixture.runs, "partial-1"));
      try {
        database.exec('DELETE FROM journal_events WHERE record LIKE \'%"type":"close"%\'');
      } finally {
        database.close();
      }

      const human = yield* xmd(fixture, ["workflow", "history", "partial-1"]).join();
      expect(human.code).toBe(0);
      expect(human.stdout).toContain("no canonical document outcome was recorded");
      expect(human.stdout).not.toContain("Outcome: completed");

      // The rest of the run still reads, so the absence is presentation rather
      // than a failure to read partial history.
      expect(human.stdout).toContain("EVENT");
      const status = yield* xmd(fixture, ["workflow", "status", "partial-1"]).join();
      expect(status.code).toBe(0);
    });
  });

  it("WFI5: reading a run changes nothing about its file", function* () {
    yield* useFixture({ "flows/release.md": RELEASE }, function* (fixture) {
      yield* xmd(fixture, ["workflow", "start", "--id=release-1", "flows/release.md"]).expect();
      const path = workflowRunPath(fixture.runs, "release-1");
      const before = fingerprint(path);

      yield* xmd(fixture, ["workflow", "status", "release-1"]).expect();
      yield* xmd(fixture, ["workflow", "list"]).expect();
      yield* xmd(fixture, ["workflow", "history", "release-1", "--json"]).expect();

      expect(fingerprint(path)).toBe(before);
    });
  });

  it("WFI6: one unreadable candidate fails the whole list", function* () {
    yield* useFixture({ "flows/release.md": RELEASE }, function* (fixture) {
      yield* xmd(fixture, ["workflow", "start", "--id=release-1", "flows/release.md"]).expect();
      const foreign = join(fixture.runs, `${"c".repeat(64)}.sqlite`);
      yield* writeTextFile(foreign, "not a workflow run database");

      const listed = yield* xmd(fixture, ["workflow", "list"]).join();
      expect(listed.code).toBe(1);
      expect(listed.stderr).toContain("not a workflow-run database");
      // No healthy subset is offered as though it were the list.
      expect(listed.stdout).not.toContain("release-1");
      // And the candidate it refused is left exactly as it was found.
      expect(readFileSync(foreign, "utf8")).toBe("not a workflow run database");

      // The run itself is still readable on its own.
      const status = yield* xmd(fixture, ["workflow", "status", "release-1"]).join();
      expect(status.code).toBe(0);
    });
  });

  it("WFI7: the grammar is by action, and refuses what an action does not have", function* () {
    yield* useFixture({ "flows/release.md": RELEASE }, function* (fixture) {
      const forkable = yield* xmd(fixture, ["workflow", "history", "r", "--forkable"]).join();
      expect(forkable.code).toBe(1);
      expect(forkable.stderr).toContain("--forkable");

      const listId = yield* xmd(fixture, ["workflow", "list", "release-1"]).join();
      expect(listId.code).toBe(1);
      expect(listId.stderr).toContain("release-1");

      const twoFilters = yield* xmd(fixture, [
        "workflow",
        "list",
        "--status=completed",
        "--status=failed",
      ]).join();
      expect(twoFilters.code).toBe(1);

      const badFilter = yield* xmd(fixture, ["workflow", "list", "--status=nowhere"]).join();
      expect(badFilter.code).toBe(1);
      expect(badFilter.stderr).toContain("nowhere");

      const statusJson = yield* xmd(fixture, ["workflow", "cancel", "release-1", "--json"]).join();
      expect(statusJson.code).toBe(1);
      expect(statusJson.stderr).toContain("--json");

      const verbose = yield* xmd(fixture, ["workflow", "status", "release-1", "--verbose"]).join();
      expect(verbose.code).toBe(1);
      expect(verbose.stderr).toContain("--verbose");

      const wildcard = yield* xmd(fixture, ["workflow", "delete", "release-*"]).join();
      expect(wildcard.code).toBe(1);
      expect(wildcard.stderr).toContain("wildcard");

      const missing = yield* xmd(fixture, ["workflow", "status"]).join();
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("run id");
    });
  });

  it("WFI8: a dash-leading run id is what `--` is for, and an extra one is refused", function* () {
    yield* useFixture({ "-release.md": RELEASE }, function* (fixture) {
      yield* xmd(fixture, [
        "workflow",
        "start",
        "--id=-inspected-run",
        "--",
        "-release.md",
      ]).expect();

      const status = yield* xmd(fixture, ["workflow", "status", "--", "-inspected-run"]).join();
      expect(status.code).toBe(0);
      expect(status.stdout).toContain("run: -inspected-run");

      const extra = yield* xmd(fixture, [
        "workflow",
        "history",
        "--",
        "-inspected-run",
        "unexpected",
      ]).join();
      expect(extra.code).toBe(1);
      expect(extra.stderr).toContain("unexpected");
    });
  });

  it("WFI10: an inspection reads no definition, so it answers outside a repository", function* () {
    yield* useFixture({ "flows/release.md": RELEASE }, function* (fixture) {
      yield* xmd(fixture, ["workflow", "start", "--id=release-1", "flows/release.md"]).expect();

      // The isolated HOME is a directory and not a working tree, so a command
      // that consulted Git or reopened the definition would fail here.
      const outside = { ...fixture, repository: fixture.home };
      const status = yield* xmd(outside, ["workflow", "status", "release-1"]).join();
      expect(status.code).toBe(0);
      expect(status.stdout).toContain("run: release-1");

      const history = yield* xmd(outside, ["workflow", "history", "release-1"]).join();
      expect(history.code).toBe(0);

      const listed = yield* xmd(outside, ["workflow", "list"]).join();
      expect(listed.code).toBe(0);
      expect(listed.stdout).toContain("release-1");
    });
  });

  it("WFI9: an absent run is reported, and reading it creates nothing", function* () {
    yield* useFixture({ "flows/release.md": RELEASE }, function* (fixture) {
      const status = yield* xmd(fixture, ["workflow", "status", "never-started"]).join();
      expect(status.code).toBe(1);
      expect(status.stderr).toContain("never-started");
      expect(status.stdout).toBe("");

      const history = yield* xmd(fixture, ["workflow", "history", "never-started"]).join();
      expect(history.code).toBe(1);

      // An empty store is an empty list rather than a failure.
      const listed = yield* xmd(fixture, ["workflow", "list"]).join();
      expect(listed.code).toBe(0);
      expect(listed.stdout).toContain("no workflow runs");
    });
  });
});
