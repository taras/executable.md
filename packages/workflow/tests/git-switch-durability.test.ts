/**
 * Tier WF — what a `<Git.Switch>` retains, replays and refuses to guess.
 *
 * The claims here are about the run's database rather than about a checkout. A
 * replay must move no branch and append no second transition; a retained result
 * that no longer parses must stop the run rather than be read around; a
 * cancelled switch must leave the frontier, the materialization and the journal
 * exactly as it found them; and the retained rows a switch runs against must be
 * the same rows afterwards, because creation identity does not move when HEAD
 * does.
 *
 * Every replay happens after the remote is deleted, so what continues a run is
 * what the run retained or nothing does.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { scoped, spawn, suspend, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { GitOperationProtocolError } from "../src/composition/errors.ts";
import { WORKSPACE_GIT_SWITCH } from "../src/deno/composition/provider.ts";
import { denoRepositoryHost } from "../src/deno/composition/host.ts";
import type { GitInvocation, GitOutcome } from "../src/deno/composition/host.ts";
import { createRun, runPath, tamper, useStorageRoot, withStorage } from "./support/storage.ts";
import { useBareRemote } from "./support/git-remotes.ts";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { when } from "@effectionx/converge";
import {
  causedBy,
  countingHost,
  countingOptions,
  gitEvents,
  gitOutcomes,
  raised,
  retainedRepositories,
  runDocument,
  subcommands,
  survivingRoots,
  workspaceText,
} from "./support/composition.ts";
import { committedRoot, dropRootClose, latestRoot, publishedRoots } from "./support/replay.ts";

const REMOTE = {
  commits: [
    { message: "first", entries: [{ path: "which.txt", content: "main\n" }] },
    {
      message: "release",
      branch: "release",
      entries: [{ path: "which.txt", content: "release\n" }],
    },
  ],
} as const;

function source(locator: string): string {
  return [
    `<Repository name="project" url="${locator}">`,
    `<Git.Switch branch="release" />`,
    `<File path="which.txt" as="which" />`,
    "",
    "after: {which}",
    "</Repository>",
  ].join("\n");
}

function isProtocolFailure(value: unknown): value is GitOperationProtocolError {
  return value instanceof GitOperationProtocolError;
}

/** Every table this run's database holds, as another connection sees them. */
function tableNames(path: string): string[] {
  const database = new DatabaseSync(path);
  try {
    return database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => String(row["name"]));
  } finally {
    database.close();
  }
}

/**
 * Damage the one retained switch result, and refuse to continue if it damaged
 * none.
 *
 * A tamper that matched nothing leaves the run healthy, and a regression built
 * on one passes by replaying an undamaged result.
 */
function damageSwitchResult(path: string, damage: (record: Record<string, unknown>) => void): void {
  let rewritten = 0;
  tamper(path, (database) => {
    for (const row of database.prepare("SELECT sequence, record FROM journal_events").all()) {
      const parsed: unknown = JSON.parse(String(row["record"]));
      const description = Object(Reflect.get(Object(parsed), "description"));
      if (Reflect.get(description, "type") !== WORKSPACE_GIT_SWITCH) {
        continue;
      }
      const value = Object(Reflect.get(Object(parsed), "result")).value;
      damage(Object(Object(value).record));
      database
        .prepare("UPDATE journal_events SET record = ? WHERE sequence = ?")
        .run(JSON.stringify(parsed), row["sequence"]);
      rewritten += 1;
    }
  });
  if (rewritten !== 1) {
    throw new Error(`the journal holds ${rewritten} switch results`);
  }
}

describe("workflow Git.Switch durability", () => {
  it("replays without moving a branch or appending a second transition", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, "release-1.4");

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      expect(String(yield* runDocument(database, source(remote.locator)))).toContain(
        "after: release",
      );
      const before = yield* gitEvents(database);
      expect(before).toHaveLength(1);
      const published = publishedRoots(path);

      dropRootClose(path);
      yield* remote.remove();

      const counting = countingHost();
      const output = yield* runDocument(
        database,
        source(remote.locator),
        countingOptions(counting),
      );

      expect(String(output)).toContain("after: release");
      expect(subcommands(counting.counters)).not.toContain("switch");
      expect(yield* gitEvents(database)).toHaveLength(1);
      // A replayed effect publishes no root, so the frontier is where the live
      // run left it.
      expect(publishedRoots(path)).toBe(published);
      expect(yield* survivingRoots(counting.counters)).toEqual([]);
    });
  });

  it("fails a replay whose retained result no longer parses", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, "release-1.4");

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runDocument(database, source(remote.locator));

      dropRootClose(path);
      damageSwitchResult(path, (record) => {
        delete record.after;
      });

      const counting = countingHost();
      const failure = yield* raised(
        runDocument(database, source(remote.locator), countingOptions(counting)),
      );

      expect(causedBy(failure, isProtocolFailure)).toBeInstanceOf(GitOperationProtocolError);
      // Nothing was re-run to make up for the damage.
      expect(subcommands(counting.counters)).not.toContain("switch");
    });
  });

  it("fails a replay whose retained result carries more than the protocol", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, "release-1.4");

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runDocument(database, source(remote.locator));

      dropRootClose(path);
      damageSwitchResult(path, (record) => {
        record.stashed = "extra";
      });

      const failure = yield* raised(runDocument(database, source(remote.locator)));
      expect(causedBy(failure, isProtocolFailure)).toBeInstanceOf(GitOperationProtocolError);
    });
  });

  it("leaves the frontier untouched when a blocked switch is halted", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, "release-1.4");

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const inner = denoRepositoryHost();
      const blocked = withResolvers<void>();
      const roots: string[] = [];
      const host = {
        *git(invocation: GitInvocation): Operation<GitOutcome> {
          if (invocation.args[0] === "switch") {
            blocked.resolve();
            yield* suspend();
          }
          return yield* inner.git(invocation);
        },
        *useDirectory(): Operation<string> {
          const directory = yield* inner.useDirectory();
          roots.push(directory);
          return directory;
        },
      };

      yield* scoped(function* () {
        const task = yield* spawn(() =>
          runDocument(database, source(remote.locator), { composition: { host } }),
        );
        yield* blocked.operation;
        yield* task.halt();
      });

      // The Repository before it committed; the switch did not, and published
      // no failed result either — a cancelled effect is not an outcome.
      expect(yield* retainedRepositories(database)).toHaveLength(1);
      expect(yield* gitEvents(database)).toHaveLength(0);
      expect(committedRoot(path)).toBe(latestRoot(path));
      expect(yield* survivingRoots({ commands: [], roots, effects: [], attachments: [] })).toEqual(
        [],
      );
    });
  });

  it("retains creation identity, no host path and no new table", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const untouched = yield* createRun({ runId: "untouched" });
      yield* runDocument(
        untouched,
        [`<Repository name="project" url="${remote.locator}" as="repository" />`].join("\n"),
      );

      const switched = yield* createRun({ runId: "switched" });
      const counting = countingHost();
      yield* runDocument(switched, source(remote.locator), countingOptions(counting));

      // A switch adds nothing to the schema: the branch it moved lives in the
      // retained checkout, not in a column.
      expect(tableNames(runPath(root, "switched"))).toEqual(tableNames(runPath(root, "untouched")));

      // And it moves nothing in the row. Creation identity is what the row
      // holds, and the checkout is on another branch by now.
      const [before] = yield* retainedRepositories(untouched);
      const [after] = yield* retainedRepositories(switched);
      expect(after?.record).toEqual(before?.record);
      expect(after?.record.primaryBranch).toBe("main");
      expect(after?.record.creationCommit).toBe(remote.heads.get("main"));
      expect(yield* workspaceText(switched, `${after?.record.checkoutPath}/which.txt`)).toBe(
        "release\n",
      );

      // Nothing the host owns reaches the journal: not the disposable
      // materialization the operation ran in, and not the directory it lived in.
      const [outcome] = yield* gitOutcomes(switched);
      const retained = JSON.stringify(outcome?.record);
      for (const materialization of counting.counters.roots) {
        expect(retained).not.toContain(materialization);
      }
      expect(retained).not.toContain(tmpdir());
    });
  });
});

/**
 * Cancellation reaches the child, not only the operation waiting on it.
 *
 * Every claim above is about what the run's database holds, which a halt that
 * left a Git process running would still satisfy. This one is about the process.
 * A named pipe is what makes a real `git` block on demand — it opens the pipe
 * for reading and waits — and the write end this test holds is what says whether
 * it is still there: writing to a pipe nothing is reading fails with `EPIPE`,
 * and writing to one a live child is reading does not.
 *
 * The blocking `open` before the halt is the premise rather than a convenience:
 * it returns only once a reader has the pipe open, so the child is provably
 * running at the moment the scope is torn down.
 */
describe("workflow Git operation teardown", () => {
  it("kills the Git child it spawned when the scope is halted", function* () {
    const directory = yield* useTempDirectory("xmd-git-teardown-");
    const pipe = `${directory}/blocked`;
    const created = spawnSync("mkfifo", [pipe]);
    if (created.status !== 0) {
      throw new Error(`mkfifo exited ${created.status}: ${created.stderr}`);
    }

    const host = denoRepositoryHost();
    const writer = yield* scoped(function* () {
      const task = yield* spawn(() =>
        host.git({ args: ["hash-object", "--", pipe], cwd: directory, home: directory }),
      );
      // Returns only once the child has the read end open, so what is halted
      // below is a Git process that is provably running.
      const opened = yield* until(open(pipe, "w"));
      yield* task.halt();
      return opened;
    });

    // Converged on rather than sampled once: `kill` returns before the signal
    // has been delivered, so a write attempted immediately can still land in a
    // pipe whose reader is about to disappear. A child that was never killed
    // keeps reading, and every attempt keeps succeeding.
    yield* when(
      function* () {
        const refused = yield* raised(until(writer.write("content")));
        expect(Reflect.get(Object(refused), "code")).toBe("EPIPE");
      },
      { timeout: 5000 },
    );
    yield* until(writer.close());
  });
});
