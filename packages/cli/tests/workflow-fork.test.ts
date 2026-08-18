/**
 * Tier WFF — `xmd workflow fork`.
 *
 * A fork is a new run whose journal begins as somebody else's. Every run here
 * shells out, so what is observed is what a caller sees: the fork's own
 * history, the source left exactly as it was, and an exit code that describes
 * the request.
 *
 * The fixture is a real Git repository and an isolated run store, because a
 * definition is what Git holds and a run is a real file.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, spawn, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, exists, rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import process from "node:process";
import { when } from "@effectionx/converge";
import { cliCommand, runCli } from "@executablemd/test-support/launch";
import { workflowForkStaging, workflowRunPath } from "@executablemd/workflow/deno";

interface Fixture {
  readonly repository: string;
  readonly runs: string;
  readonly home: string;
}

/**
 * A fork's candidate is byte-compatible through the checkpoint or it is not
 * compatible at all, and authored positions take part in effect identity — so
 * every candidate here is the same document at the same path, edited only after
 * the event the fork selects.
 */
const DEFINITION = "flows/release.md";

/** Two committed durable effects, and Workspace-root movement between them. */
const SOURCE = [
  "# Release",
  "",
  '<File path="notes.md">first</File>',
  "",
  "```bash exec",
  "echo original",
  "```",
  "",
].join("\n");

/** Byte-compatible through the file effect, and different after it. */
const CORRECTED = [
  "# Release",
  "",
  '<File path="notes.md">first</File>',
  "",
  "```bash exec",
  "echo corrected",
  "```",
  "",
].join("\n");

/**
 * The file effect writes somewhere else, so the inherited prefix expects an
 * operation this candidate never performs.
 *
 * A durable effect's identity is its type and its name, and a `<File>` names the
 * path it writes and where it was written. Changing only the *content* would
 * replay the recorded write exactly as a resume does, which is why divergence
 * is planted where identity actually lives.
 */
const DIVERGENT = [
  "# Release",
  "",
  '<File path="elsewhere.md">first</File>',
  "",
  "```bash exec",
  "echo corrected",
  "```",
  "",
].join("\n");

/**
 * A document that declares a property and writes it, so what a fork inherited
 * is visible in what it did rather than only in what it retained.
 */
const PROPPED = [
  "---",
  "props:",
  "  type: object",
  "  properties:",
  "    channel: { type: string }",
  "  required: [channel]",
  "  additionalProperties: false",
  "---",
  "",
  "# Release",
  "",
  '<File path="notes.md">first</File>',
  "",
  "```bash exec",
  "echo original",
  "```",
  "",
].join("\n");

/** The same document, edited only after the checkpoint. */
const PROPPED_CORRECTED = PROPPED.replace("echo original", "echo corrected");

/** Compatible through the checkpoint, and slow enough after it to be killed. */
const SLOW = [
  "# Release",
  "",
  '<File path="notes.md">first</File>',
  "",
  "```bash exec",
  "sleep 30",
  "```",
  "",
].join("\n");

/** Nothing at all after the heading, so it never reaches the checkpoint. */
const EMPTY = ["# Release", "", "Nothing happens here.", ""].join("\n");

/**
 * A document that pushes to a local bare remote and then does one more thing.
 *
 * `<Git.Push>` is the shipped external-effect surface, and a completed push
 * retains a reconciliation record — the pre-state, the observations, the
 * decision and the result — that replays without contacting anything.
 */
function pushing(remote: string, tail: string): string {
  return [
    '<Repository name="project" url="' + remote + '">',
    '<Git.Switch branch="publish/1" />',
    '<File path="notes.md">',
    "prepared",
    "</File>",
    '<Git.Add paths="notes.md" />',
    '<Git.Commit message="prepare" as="commit" />',
    "<Git.Push />",
    "</Repository>",
    "",
    "```bash exec",
    tail,
    "```",
    "",
  ].join("\n");
}

/** A bare remote with one commit on `main`, and optionally one that refuses pushes. */
function* useRemote(root: string, refusing = false): Operation<string> {
  const bare = join(root, refusing ? "refusing.git" : "remote.git");
  const seed = join(root, `seed-${refusing ? "refusing" : "remote"}`);
  yield* ensureDir(seed);
  yield* git(seed, ["init", "-q", "--initial-branch=main", "."]);
  yield* git(seed, ["config", "user.email", "tier-wff@example.test"]);
  yield* git(seed, ["config", "user.name", "Tier WFF"]);
  yield* writeTextFile(join(seed, "which.txt"), "main\n");
  yield* git(seed, ["add", "-A"]);
  yield* git(seed, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "first"]);
  yield* git(root, ["init", "-q", "--bare", bare]);
  yield* git(seed, ["push", "-q", bare, "main"]);
  if (refusing) {
    // The destination ref already exists, at a commit the run's own branch does
    // not descend from. The push observes that and refuses, so what the run
    // retains is a Git-host effect that established no completion.
    yield* git(seed, ["push", "-q", bare, "main:refs/heads/publish/1"]);
  }
  return bare;
}

function* git(repository: string, args: string[]): Operation<void> {
  const result = yield* exec("git", { arguments: args, cwd: repository }).expect();
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function* commit(
  fixture: Fixture,
  files: Record<string, string>,
  message: string,
): Operation<void> {
  for (const [name, content] of Object.entries(files)) {
    const path = join(fixture.repository, name);
    yield* ensureDir(join(path, ".."));
    yield* writeTextFile(path, content);
  }
  yield* git(fixture.repository, ["add", "-A"]);
  // The fixture is not the developer's repository: whatever signing their own
  // configuration asks for is not this commit's business.
  yield* git(fixture.repository, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
}

function useFixture<T>(
  files: Record<string, string>,
  body: (fixture: Fixture) => Operation<T>,
): Operation<T> {
  return scoped(function* () {
    const root = join(tmpdir(), `xmd-wff-${randomUUID()}`);
    const fixture: Fixture = {
      repository: join(root, "repository"),
      runs: join(root, "runs"),
      home: join(root, "home"),
    };
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    yield* ensureDir(fixture.repository);
    yield* ensureDir(fixture.home);

    yield* git(fixture.repository, ["init", "-q", "--initial-branch=main", "."]);
    yield* git(fixture.repository, ["config", "user.email", "tier-wff@example.test"]);
    yield* git(fixture.repository, ["config", "user.name", "Tier WFF"]);
    yield* commit(fixture, files, "definition");

    return yield* body(fixture);
  });
}

function xmd(fixture: Fixture, args: string[]) {
  return runCli(args, {
    cwd: fixture.repository,
    env: { HOME: fixture.home, XMD_WORKFLOW_RUNS: fixture.runs },
  });
}

interface HistoryRow {
  readonly eventId: string;
  readonly event: {
    readonly type: string;
    readonly coroutineId: string;
    readonly description?: { readonly type: string; readonly name?: string };
    readonly result?: { readonly status: string };
  };
  readonly workspaceRootId: string;
  readonly source?: { readonly path?: string; readonly line: number; readonly column: number };
  readonly forkability: {
    readonly forkable: boolean;
    readonly blockers: readonly { readonly code: string; readonly eventId: string }[];
  };
  readonly inherited?: { readonly sourceRunId: string; readonly sourceEventId: string };
}

function* snapshot(fixture: Fixture, runId: string): Operation<Record<string, unknown>> {
  const answered = yield* xmd(fixture, ["workflow", "status", runId, "--json"]).join();
  expect(answered.code).toBe(0);
  return JSON.parse(answered.stdout);
}

/** The normalized properties one run retains. */
function props(snapshot: Record<string, unknown>): unknown {
  return (snapshot["record"] as Record<string, unknown>)["props"];
}

function status(snapshot: Record<string, unknown>): unknown {
  return (snapshot["record"] as Record<string, unknown>)["status"];
}

function* history(fixture: Fixture, runId: string): Operation<HistoryRow[]> {
  const answered = yield* xmd(fixture, ["workflow", "history", runId, "--json"]).join();
  expect(answered.code).toBe(0);
  return JSON.parse(answered.stdout);
}

/** The retained row for one durable operation type, which the fork selects. */
function at(entries: readonly HistoryRow[], type: string): HistoryRow {
  const row = entries.find(
    (entry) => entry.event.type === "yield" && entry.event.description?.type === type,
  );
  if (row === undefined) {
    throw new Error(`no retained ${type} event: ${entries.map(named).join(", ")}`);
  }
  return row;
}

function named(entry: HistoryRow): string {
  return entry.event.type === "yield"
    ? `${entry.event.description?.type}`
    : `close(${entry.event.coroutineId})`;
}

/** Every byte of one run's database, so an unchanged source can be proved. */
function* bytes(path: string): Operation<string> {
  return (yield* until(readFile(path))).toString("base64");
}

/**
 * Fork in a real child, wait until the commit has landed, and kill it.
 *
 * The wait is on what the fork's own database has published — its journal
 * holding the inherited prefix and nothing after it — so the signal always
 * lands after the commit and before the live suffix appends anything.
 */
function killedFork(
  fixture: Fixture,
  checkpointEventId: string,
  path: string,
): Operation<{ signal: string | null | undefined }> {
  return scoped(function* () {
    const cli = cliCommand([
      "workflow",
      "fork",
      "source-1",
      `--at=${checkpointEventId}`,
      "--id=fork-1",
      DEFINITION,
    ]);
    const child = yield* exec(cli.command, {
      arguments: cli.arguments,
      cwd: fixture.repository,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([, value]) => value !== undefined),
        ),
        HOME: fixture.home,
        XMD_WORKFLOW_RUNS: fixture.runs,
      },
    });
    // Read the child's streams so a full pipe cannot stall it before it has
    // committed anything.
    for (const stream of [child.stdout, child.stderr]) {
      yield* spawn(function* () {
        const subscription = yield* stream;
        let next = yield* subscription.next();
        while (!next.done) {
          next = yield* subscription.next();
        }
      });
    }

    yield* when(
      function* () {
        expect(committedEvents(path)).toContain(checkpointEventId);
      },
      { timeout: 120_000 },
    );
    process.kill(child.pid, "SIGKILL");
    const status = yield* child.join();
    return { signal: status.signal };
  });
}

/**
 * Every retained event id, read straight from the fork's own database.
 *
 * Synchronous because the condition it feeds is: `when()` polls a predicate
 * that cannot suspend, and an absent, half-written or uncommitted database is
 * "not yet" rather than a failure to report.
 */
function committedEvents(path: string): string[] {
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(path, { readOnly: true });
  } catch {
    // The fork has not created its database yet.
    return [];
  }
  try {
    return database
      .prepare("SELECT event_id FROM journal_events ORDER BY sequence ASC")
      .all()
      .map((row) => String(row["event_id"]));
  } catch {
    // Mid-commit, so there is nothing to read yet.
    return [];
  } finally {
    database.close();
  }
}

describe("Tier WFF — xmd workflow fork", () => {
  it("WFF1: a compatible checkpoint admits a fork whose history begins as its own", function* () {
    yield* useFixture({ [DEFINITION]: SOURCE }, function* (fixture) {
      {
        yield* xmd(fixture, ["workflow", "start", "--id=source-1", DEFINITION]).expect();
        const source = yield* history(fixture, "source-1");
        const checkpoint = at(source, "workspace_file");
        expect(checkpoint.forkability.forkable).toBe(true);

        yield* commit(fixture, { [DEFINITION]: CORRECTED }, "corrected");
        const forked = yield* xmd(fixture, [
          "workflow",
          "fork",
          "source-1",
          `--at=${checkpoint.eventId}`,
          "--id=fork-1",
          DEFINITION,
        ]).join();
        expect(forked.code).toBe(0);
        expect(forked.stderr).toContain("workflow run: fork-1");
        expect(forked.stderr).toContain("workflow status: completed");

        const entries = yield* history(fixture, "fork-1");

        // The fork's own run record stands where the source's stood, under a
        // fork event id, and the source's is nowhere in this history.
        const record = at(entries, "workflow_run");
        expect(record.eventId).not.toBe(at(source, "workflow_run").eventId);
        expect(record.inherited).toBe(undefined);

        // The root import is the fork's own too: it holds the document's text,
        // and this fork runs the definition it was given.
        const imported = at(entries, "import_component");
        expect(imported.inherited).toBe(undefined);

        // The inherited event keeps its public id, its authored source and its
        // Workspace root, and says where it came from.
        const inherited = at(entries, "workspace_file");
        expect(inherited.eventId).toBe(checkpoint.eventId);
        expect(inherited.workspaceRootId).toBe(checkpoint.workspaceRootId);
        expect(inherited.source).toEqual(checkpoint.source);
        expect(inherited.inherited).toEqual({
          sourceRunId: "source-1",
          sourceEventId: checkpoint.eventId,
        });

        // The live suffix is the fork's own, under fork event ids.
        const live = at(entries, "exec");
        expect(live.inherited).toBe(undefined);
        expect(live.eventId).not.toBe(at(source, "exec").eventId);

        // And the run reports where it came from.
        const status = yield* xmd(fixture, ["workflow", "status", "fork-1", "--json"]).join();
        expect(status.code).toBe(0);
        const snapshot = JSON.parse(status.stdout);
        expect(snapshot.lineage).toEqual({
          sourceRunId: "source-1",
          checkpointEventId: checkpoint.eventId,
          checkpointWorkspaceRootId: checkpoint.workspaceRootId,
        });
        // The Workspace the fork started from is the one the checkpoint named.
        expect(inherited.workspaceRootId).toBe(snapshot.lineage.checkpointWorkspaceRootId);
      }
    });
  });

  it("WFF2: forking changes nothing about the source and takes no lock on it", function* () {
    yield* useFixture({ [DEFINITION]: SOURCE }, function* (fixture) {
      {
        yield* xmd(fixture, ["workflow", "start", "--id=source-1", DEFINITION]).expect();
        const source = yield* history(fixture, "source-1");
        const checkpoint = at(source, "workspace_file");
        const before = yield* bytes(workflowRunPath(fixture.runs, "source-1"));

        yield* commit(fixture, { [DEFINITION]: CORRECTED }, "corrected");
        yield* xmd(fixture, [
          "workflow",
          "fork",
          "source-1",
          `--at=${checkpoint.eventId}`,
          "--id=fork-1",
          DEFINITION,
        ]).expect();

        // Byte for byte: no row was written, no lifecycle state moved, and the
        // events after the checkpoint stayed where they were.
        expect(yield* bytes(workflowRunPath(fixture.runs, "source-1"))).toBe(before);
        expect(yield* history(fixture, "source-1")).toEqual(source);

        // The source's own events after the checkpoint are not in the fork's
        // inherited prefix: its `exec` is the fork's own.
        const forkExec = at(yield* history(fixture, "fork-1"), "exec");
        expect(forkExec.inherited).toBe(undefined);

        // The source is still resumable, which proves nothing holds its lock.
        const resumed = yield* xmd(fixture, ["workflow", "resume", "source-1"]).join();
        expect(resumed.code).toBe(0);
      }
    });
  });

  it("WFF3: the fork owns its inherited prefix once the source is deleted", function* () {
    yield* useFixture({ [DEFINITION]: SOURCE }, function* (fixture) {
      {
        yield* xmd(fixture, ["workflow", "start", "--id=source-1", DEFINITION]).expect();
        const source = yield* history(fixture, "source-1");
        const checkpoint = at(source, "workspace_file");

        yield* commit(fixture, { [DEFINITION]: CORRECTED }, "corrected");
        yield* xmd(fixture, [
          "workflow",
          "fork",
          "source-1",
          `--at=${checkpoint.eventId}`,
          "--id=fork-1",
          DEFINITION,
        ]).expect();

        const deleted = yield* xmd(fixture, ["workflow", "delete", "source-1"]).join();
        expect(deleted.code).toBe(0);
        const gone = yield* xmd(fixture, ["workflow", "status", "source-1"]).join();
        expect(gone.code).toBe(1);

        // The fork still reads, still holds the inherited row, and still names
        // the Workspace root that row was written against.
        const entries = yield* history(fixture, "fork-1");
        const inherited = at(entries, "workspace_file");
        expect(inherited.eventId).toBe(checkpoint.eventId);
        expect(inherited.workspaceRootId).toBe(checkpoint.workspaceRootId);
        expect(inherited.inherited?.sourceRunId).toBe("source-1");

        // And continuing it consults nothing that is gone.
        const resumed = yield* xmd(fixture, ["workflow", "resume", "fork-1"]).join();
        expect(resumed.code).toBe(0);
        expect(resumed.stderr).toContain("workflow status: completed");
      }
    });
  });

  it("WFF4: divergence before the checkpoint leaves no fork at all", function* () {
    yield* useFixture({ [DEFINITION]: SOURCE }, function* (fixture) {
      {
        yield* xmd(fixture, ["workflow", "start", "--id=source-1", DEFINITION]).expect();
        const source = yield* history(fixture, "source-1");
        const checkpoint = at(source, "workspace_file");
        const before = yield* bytes(workflowRunPath(fixture.runs, "source-1"));

        yield* commit(fixture, { [DEFINITION]: DIVERGENT }, "divergent");
        const diverged = yield* xmd(fixture, [
          "workflow",
          "fork",
          "source-1",
          `--at=${checkpoint.eventId}`,
          "--id=fork-1",
          DEFINITION,
        ]).join();
        expect(diverged.code).toBe(1);
        expect(diverged.stderr).toContain("diverges");
        // The boundary is named, so a caller knows which event stopped agreeing.
        expect(diverged.stderr).toContain(checkpoint.eventId);

        // Nothing recognizable was created, and `list` still answers — which it
        // would not if an empty database had been left at the fork's path.
        const listed = yield* xmd(fixture, ["workflow", "list", "--json"]).join();
        expect(listed.code).toBe(0);
        expect(
          JSON.parse(listed.stdout).map(
            (snapshot: { record: { runId: string } }) => snapshot.record.runId,
          ),
        ).toEqual(["source-1"]);
        expect(yield* bytes(workflowRunPath(fixture.runs, "source-1"))).toBe(before);

        // A candidate that stops before the checkpoint is refused on the same
        // terms: it never reaches the history it asked to inherit.
        yield* commit(fixture, { [DEFINITION]: EMPTY }, "empty");
        const short = yield* xmd(fixture, [
          "workflow",
          "fork",
          "source-1",
          `--at=${checkpoint.eventId}`,
          "--id=fork-2",
          DEFINITION,
        ]).join();
        expect(short.code).toBe(1);
        expect(short.stderr).toContain("diverges");
        const after = yield* xmd(fixture, ["workflow", "list", "--json"]).join();
        expect(after.code).toBe(0);
        expect(JSON.parse(after.stdout)).toHaveLength(1);
      }
    });
  });

  it("WFF5: a reused fork id is compatible only for the same fork identity", function* () {
    yield* useFixture({ [DEFINITION]: SOURCE }, function* (fixture) {
      {
        yield* xmd(fixture, ["workflow", "start", "--id=source-1", DEFINITION]).expect();
        const source = yield* history(fixture, "source-1");
        const checkpoint = at(source, "workspace_file");
        const record = at(source, "workflow_run");

        const fork = (checkpointEventId: string) => [
          "workflow",
          "fork",
          "source-1",
          `--at=${checkpointEventId}`,
          "--id=fork-1",
          DEFINITION,
        ];

        yield* commit(fixture, { [DEFINITION]: CORRECTED }, "corrected");
        yield* xmd(fixture, fork(checkpoint.eventId)).expect();
        const first = yield* history(fixture, "fork-1");

        // The same terms again address the same fork.
        const again = yield* xmd(fixture, fork(checkpoint.eventId)).join();
        expect(again.code).toBe(0);
        expect(yield* history(fixture, "fork-1")).toEqual(first);

        // A different checkpoint is a different fork wearing this id, and it is
        // reported as the checkpoint rather than collapsed into one cause.
        const elsewhere = yield* xmd(fixture, fork(record.eventId)).join();
        expect(elsewhere.code).toBe(1);
        expect(elsewhere.stderr).toContain("checkpoint");

        // And so is a different definition.
        yield* commit(
          fixture,
          { [DEFINITION]: CORRECTED.replace("echo corrected", "echo elsewhere") },
          "elsewhere",
        );
        const other = yield* xmd(fixture, fork(checkpoint.eventId)).join();
        expect(other.code).toBe(1);
        expect(other.stderr).toContain("definition");
        expect(other.stderr).not.toContain("checkpoint");

        expect(yield* history(fixture, "fork-1")).toEqual(first);
      }
    });
  });

  it("WFF9: a fork inherits the source's props, and an explicit one overrides", function* () {
    yield* useFixture({ [DEFINITION]: PROPPED }, function* (fixture) {
      // The generated property arguments follow the positionals: configliere
      // stops at the first option it does not define, so a `--props-*` written
      // ahead of a positional hides it.
      yield* xmd(fixture, [
        "workflow",
        "start",
        "--id=source-1",
        DEFINITION,
        "--props-channel=stable",
      ]).expect();
      const source = yield* history(fixture, "source-1");
      const checkpoint = at(source, "workspace_file");

      yield* commit(fixture, { [DEFINITION]: PROPPED_CORRECTED }, "corrected");

      // The property is not restated. A corrected definition is still a run of
      // the same procedure, and the source retained what it was started with.
      const inheriting = yield* xmd(fixture, [
        "workflow",
        "fork",
        "source-1",
        `--at=${checkpoint.eventId}`,
        "--id=fork-inherited",
        DEFINITION,
      ]).join();
      expect(inheriting.code).toBe(0);
      expect(props(yield* snapshot(fixture, "fork-inherited"))).toEqual({ channel: "stable" });

      // And the run used it: the document declares `channel` as required, so a
      // fork that inherited nothing would have been refused before it ran.
      expect(status(yield* snapshot(fixture, "fork-inherited"))).toBe("completed");

      // An explicit argument overrides, property by property.
      const overriding = yield* xmd(fixture, [
        "workflow",
        "fork",
        "source-1",
        `--at=${checkpoint.eventId}`,
        "--id=fork-overridden",
        DEFINITION,
        "--props-channel=beta",
      ]).join();
      expect(overriding.code).toBe(0);
      expect(props(yield* snapshot(fixture, "fork-overridden"))).toEqual({ channel: "beta" });

      // The merged props are the fork's identity, so they are a term of
      // compatible reuse: the same id with a different value is refused, and
      // the same id with the same value is the same fork again.
      const conflicting = yield* xmd(fixture, [
        "workflow",
        "fork",
        "source-1",
        `--at=${checkpoint.eventId}`,
        "--id=fork-overridden",
        DEFINITION,
        "--props-channel=nightly",
      ]).join();
      expect(conflicting.code).toBe(1);
      expect(conflicting.stderr).toContain("props");
      // The value that conflicts is retained history and is not repeated back.
      expect(conflicting.stderr).not.toContain("nightly");
      expect(props(yield* snapshot(fixture, "fork-overridden"))).toEqual({ channel: "beta" });

      const again = yield* xmd(fixture, [
        "workflow",
        "fork",
        "source-1",
        `--at=${checkpoint.eventId}`,
        "--id=fork-overridden",
        DEFINITION,
        "--props-channel=beta",
      ]).join();
      expect(again.code).toBe(0);
    });
  });

  it("WFF10: a completed Git-host record is inherited without contacting anything", function* () {
    yield* useFixture({ [DEFINITION]: "# placeholder\n" }, function* (fixture) {
      const remote = yield* useRemote(join(fixture.repository, ".."));
      yield* commit(fixture, { [DEFINITION]: pushing(remote, "echo original") }, "pushing");

      yield* xmd(fixture, ["workflow", "start", "--id=source-1", DEFINITION]).expect();
      const source = yield* history(fixture, "source-1");
      const pushed = at(source, "git_host_effect");

      // The checkpoint at the push is forkable: what the history holds about
      // the remote is a completed reconciliation record, not a promise to ask.
      expect(pushed.forkability).toEqual({ forkable: true, blockers: [] });

      yield* commit(fixture, { [DEFINITION]: pushing(remote, "echo corrected") }, "corrected");

      // The remote is gone. Anything that reached for it — an observation, a
      // second push — would fail here rather than be replayed.
      yield* rm(remote, { recursive: true, force: true });

      const forked = yield* xmd(fixture, [
        "workflow",
        "fork",
        "source-1",
        `--at=${pushed.eventId}`,
        "--id=fork-1",
        DEFINITION,
      ]).join();
      expect(forked.code).toBe(0);
      expect(forked.stderr).toContain("workflow status: completed");

      const entries = yield* history(fixture, "fork-1");
      const inherited = at(entries, "git_host_effect");

      // The inherited event is the source's, unchanged and unrewritten: its
      // public id, its Workspace root, and the run it came from.
      expect(inherited.eventId).toBe(pushed.eventId);
      expect(inherited.workspaceRootId).toBe(pushed.workspaceRootId);
      expect(inherited.event).toEqual(pushed.event);
      expect(inherited.inherited).toEqual({
        sourceRunId: "source-1",
        sourceEventId: pushed.eventId,
      });

      // And the fork is the authority for what it ran itself.
      const live = at(entries, "exec");
      expect(live.inherited).toBe(undefined);
      expect(live.eventId).not.toBe(at(source, "exec").eventId);
    });
  });

  it("WFF11: a Git-host effect that established nothing is not forkable", function* () {
    yield* useFixture({ [DEFINITION]: "# placeholder\n" }, function* (fixture) {
      const remote = yield* useRemote(join(fixture.repository, ".."), true);
      yield* commit(fixture, { [DEFINITION]: pushing(remote, "echo original") }, "pushing");

      const started = yield* xmd(fixture, [
        "workflow",
        "start",
        "--id=source-1",
        DEFINITION,
      ]).join();
      // The remote refused, so the run failed and retains no completion.
      expect(started.code).not.toBe(0);

      const source = yield* history(fixture, "source-1");
      const refused = at(source, "git_host_effect");
      expect(refused.event.result?.status).not.toBe("ok");
      expect(refused.forkability.forkable).toBe(false);
      expect(refused.forkability.blockers).toEqual([
        { code: "external-state-unavailable", eventId: refused.eventId },
      ]);

      // Cumulative: every later checkpoint carries it, naming that event.
      for (const entry of source.slice(source.indexOf(refused))) {
        expect(entry.forkability.blockers).toEqual([
          { code: "external-state-unavailable", eventId: refused.eventId },
        ]);
      }

      const forked = yield* xmd(fixture, [
        "workflow",
        "fork",
        "source-1",
        `--at=${refused.eventId}`,
        "--id=fork-1",
        DEFINITION,
      ]).join();
      expect(forked.code).toBe(1);
      expect(forked.stderr).toContain("external-state-unavailable");
      // The refusal names a code and an event, and nothing the remote said.
      expect(forked.stderr).not.toContain("refuses pushes");

      // An earlier checkpoint is still forkable: the blocker is where it is.
      const before = at(source, "workspace_git_commit");
      expect(before.forkability.forkable).toBe(true);
    });
  });

  it("WFF6: the fork commit is the boundary a crash falls on one side of", function* () {
    yield* useFixture({ [DEFINITION]: SOURCE }, function* (fixture) {
      yield* xmd(fixture, ["workflow", "start", "--id=source-1", DEFINITION]).expect();
      const source = yield* history(fixture, "source-1");
      const checkpoint = at(source, "workspace_file");

      // Before the commit: a candidate that cannot carry the prefix leaves the
      // destination absent, and the staging the preflight built absent too.
      yield* commit(fixture, { [DEFINITION]: DIVERGENT }, "divergent");
      const refused = yield* xmd(fixture, [
        "workflow",
        "fork",
        "source-1",
        `--at=${checkpoint.eventId}`,
        "--id=fork-1",
        DEFINITION,
      ]).join();
      expect(refused.code).toBe(1);
      expect(yield* exists(workflowRunPath(fixture.runs, "fork-1"))).toBe(false);
      expect(yield* exists(workflowForkStaging(fixture.runs, "fork-1"))).toBe(false);

      // After the commit: the fork is killed while its live suffix is still
      // running, so nothing it was about to append exists.
      yield* commit(fixture, { [DEFINITION]: SLOW }, "slow");
      const path = workflowRunPath(fixture.runs, "fork-1");
      const killed = yield* killedFork(fixture, checkpoint.eventId, path);
      expect(killed.signal).toBe("SIGKILL");

      // What it left is an ordinary interrupted run that happens to be a fork:
      // its lineage, its inherited prefix and its selected Workspace root.
      const snapshot = JSON.parse(
        (yield* xmd(fixture, ["workflow", "status", "fork-1", "--json"]).join()).stdout,
      );
      expect(snapshot.record.status).toBe("running");
      expect(snapshot.lineage).toEqual({
        sourceRunId: "source-1",
        checkpointEventId: checkpoint.eventId,
        checkpointWorkspaceRootId: checkpoint.workspaceRootId,
      });
      const entries = yield* history(fixture, "fork-1");
      expect(at(entries, "workspace_file").eventId).toBe(checkpoint.eventId);

      // And recovery treats it like any other run whose executor went away.
      const resumed = yield* xmd(fixture, ["workflow", "cancel", "fork-1"]).join();
      expect(resumed.code).toBe(0);
      expect(resumed.stdout).toContain("fork-1");
    });
  });

  it("WFF7: history forkability is stable, cumulative and free of retained values", function* () {
    yield* useFixture({ [DEFINITION]: SOURCE }, function* (fixture) {
      yield* xmd(fixture, ["workflow", "start", "--id=source-1", DEFINITION]).expect();

      // Every entry carries forkability whether or not `--forkable` was
      // written: the JSON is the contract, and the flag is a presentation.
      const plain = yield* history(fixture, "source-1");
      expect(plain.every((entry) => entry.forkability !== undefined)).toBe(true);
      expect(plain.every((entry) => entry.forkability.forkable)).toBe(true);
      expect(plain.every((entry) => entry.forkability.blockers.length === 0)).toBe(true);

      const structured = yield* xmd(fixture, [
        "workflow",
        "history",
        "source-1",
        "--forkable",
        "--json",
      ]).join();
      expect(structured.code).toBe(0);
      expect(JSON.parse(structured.stdout)).toEqual(plain);

      const human = yield* xmd(fixture, ["workflow", "history", "source-1", "--forkable"]).join();
      expect(human.code).toBe(0);
      expect(human.stdout).toContain("FORKABLE");
      expect(human.stdout).toContain("BLOCKERS");
      // Every row the plain rendering shows is still there.
      const rows = human.stdout.split("\n").filter((line) => line.includes("yes"));
      expect(rows.length).toBeGreaterThan(0);

      // Which checkpoints are *not* forkable is decided from retained event
      // types, and a history holding one is not something this fixture can
      // produce on purpose. Tier WFK exercises every blocker directly.
    });
  });

  it("WFF8: the fork grammar is action-scoped", function* () {
    yield* useFixture({ [DEFINITION]: SOURCE }, function* (fixture) {
      {
        const noCheckpoint = yield* xmd(fixture, [
          "workflow",
          "fork",
          "source-1",
          DEFINITION,
        ]).join();
        expect(noCheckpoint.code).toBe(1);
        expect(noCheckpoint.stderr).toContain("--at");

        const noDefinition = yield* xmd(fixture, [
          "workflow",
          "fork",
          "source-1",
          "--at=whatever",
        ]).join();
        expect(noDefinition.code).toBe(1);
        expect(noDefinition.stderr).toContain("markdown definition");

        const noSource = yield* xmd(fixture, ["workflow", "fork"]).join();
        expect(noSource.code).toBe(1);
        expect(noSource.stderr).toContain("the run it continues");

        // `--at` belongs to a fork and to nothing else.
        const strayAt = yield* xmd(fixture, ["workflow", "resume", "source-1", "--at=x"]).join();
        expect(strayAt.code).toBe(1);
        expect(strayAt.stderr).toContain("--at");

        // Read-only actions still take no properties and no fork options.
        const strayProps = yield* xmd(fixture, [
          "workflow",
          "history",
          "source-1",
          "--props-channel=stable",
        ]).join();
        expect(strayProps.code).toBe(1);
        expect(strayProps.stderr).toContain("--props");

        const strayForkable = yield* xmd(fixture, [
          "workflow",
          "status",
          "source-1",
          "--forkable",
        ]).join();
        expect(strayForkable.code).toBe(1);
        expect(strayForkable.stderr).toContain("--forkable");

        // A fourth positional is refused rather than silently ignored.
        const extra = yield* xmd(fixture, [
          "workflow",
          "fork",
          "source-1",
          "--at=x",
          DEFINITION,
          DEFINITION,
        ]).join();
        expect(extra.code).toBe(1);
        expect(extra.stderr).toContain("unrecognized argument");
      }
    });
  });
});
