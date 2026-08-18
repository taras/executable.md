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
import { GitOperationError, GitOperationProtocolError } from "../src/composition/errors.ts";
import { DivergenceError } from "@executablemd/durable-streams";
import { RepositoryContext } from "../src/composition/context.ts";
import type { RepositoryRecord } from "../src/composition/records.ts";
import { gitOperationFingerprint } from "../src/deno/composition/operations.ts";
import { withWorkflowWorkspace } from "../src/deno/workspace/host.ts";
import type { WorkflowWorkspaceOptions } from "../src/deno/workspace/host.ts";
import type { WorkflowRunDatabase } from "../src/storage/api.ts";
import { collect, execute, inlineSource } from "@executablemd/core";
import type { Json } from "@executablemd/durable-streams";
import { WORKSPACE_GIT_SWITCH } from "../src/deno/composition/provider.ts";
import { denoRepositoryHost } from "../src/deno/composition/host.ts";
import type { GitInvocation, GitOutcome } from "../src/deno/composition/host.ts";
import { createRun, runPath, tamper, useStorageRoot, withStorage } from "./support/storage.ts";
import { useBareRemote } from "./support/git-remotes.ts";
import { useTempDirectory } from "@executablemd/test-support/temp";
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

/** A switch of a linked Worktree, so a suite can damage the pairing it retains. */
function worktreeSource(locator: string): string {
  return [
    `<Repository name="project" url="${locator}">`,
    `<Worktree name="implementation" branch="feature/new" as="worktree" />`,
    "<Dir path={worktree}>",
    `<Git.Switch branch="release" />`,
    `<File path="which.txt" as="which" />`,
    "",
    "after: {which}",
    "</Dir>",
    "</Repository>",
  ].join("\n");
}

/** A switch to the branch the checkout is already on, which moves nothing. */
function unchangedSource(locator: string): string {
  return [
    `<Repository name="project" url="${locator}">`,
    `<Git.Switch branch="main" />`,
    `<File path="which.txt" as="which" />`,
    "",
    "after: {which}",
    "</Repository>",
  ].join("\n");
}

function isProtocolFailure(value: unknown): value is GitOperationProtocolError {
  return value instanceof GitOperationProtocolError;
}

function isDivergence(value: unknown): value is DivergenceError {
  return value instanceof DivergenceError;
}

function isGitFailure(value: unknown): value is GitOperationError {
  return value instanceof GitOperationError;
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

/**
 * One `<Git.Switch>` inside the checkout, under a supplied Repository context.
 *
 * A self-closing `<Repository>` retains a checkout and installs no context, so
 * the record the component observes is exactly the one a caller supplies here —
 * which is what a replaced context is, and what makes the two runs below differ
 * by nothing but that record.
 */
function observedSource(locator: string): string {
  return [
    `<Repository name="project" url="${locator}" as="repository" />`,
    "<Dir path={repository}>",
    `<Git.Switch branch="release" />`,
    "</Dir>",
  ].join("\n");
}

function runObserved(
  database: WorkflowRunDatabase,
  record: RepositoryRecord,
  locator: string,
  options: WorkflowWorkspaceOptions,
): Operation<Json> {
  return scoped(function* () {
    return yield* withWorkflowWorkspace(
      database,
      scoped(function* () {
        yield* RepositoryContext.around({ current: () => record }, { at: "min" });
        return yield* collect(
          yield* execute({ ...inlineSource(observedSource(locator)), stream: database.journal }),
        );
      }),
      options,
    );
  });
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

  /**
   * Every way a retained result can stop describing the invocation it was
   * recorded for.
   *
   * Shape is the cheap half. The rest is meaning: an object id that is not one,
   * a checkout that is not the one this request selects, a branch or base that
   * is not the one it asked for, and a transition the two readings cannot both
   * be part of. Each is damage a hand-edited or foreign database can hold, and
   * each has to stop the replay rather than be read around.
   */
  const DAMAGE: { name: string; damage: (record: Record<string, unknown>) => void }[] = [
    {
      name: "is missing a member the protocol declares",
      damage: (record) => {
        delete record.after;
      },
    },
    {
      name: "carries more than the protocol declares",
      damage: (record) => {
        record.stashed = "extra";
      },
    },
    {
      name: "holds something that is not an object id",
      damage: (record) => {
        Object(record.after).commit = "not-an-oid";
      },
    },
    {
      name: "holds an object id in the wrong case",
      damage: (record) => {
        Object(record.after).commit = String(Object(record.after).commit).toUpperCase();
      },
    },
    {
      name: "names another Repository",
      damage: (record) => {
        Object(record.checkout).repositoryName = "other";
      },
    },
    {
      name: "names a checkout path that is not one place in the Workspace",
      damage: (record) => {
        Object(record.checkout).checkoutPath = "/repositories/../etc";
      },
    },
    {
      name: "names a branch the invocation did not ask for",
      damage: (record) => {
        record.requestedBranch = "other";
      },
    },
    {
      name: "ends on a branch the invocation did not ask for",
      damage: (record) => {
        record.resolvedBranch = "other";
        Object(record.after).branch = "other";
      },
    },
    {
      name: "claims a base the transition contradicts",
      damage: (record) => {
        record.resolvedBase = Object(record.before).commit;
      },
    },
  ];

  for (const { name, damage } of DAMAGE) {
    it(`fails a replay whose retained result ${name}`, function* () {
      const root = yield* useStorageRoot();
      const remote = yield* useBareRemote(REMOTE);
      const path = runPath(root, "release-1.4");

      yield* withStorage(root, function* () {
        const database = yield* createRun();
        yield* runDocument(database, source(remote.locator));

        dropRootClose(path);
        damageSwitchResult(path, damage);

        const counting = countingHost();
        const failure = yield* raised(
          runDocument(database, source(remote.locator), countingOptions(counting)),
        );

        expect(causedBy(failure, isProtocolFailure)).toBeInstanceOf(GitOperationProtocolError);
        // Nothing was re-run to make up for the damage.
        expect(subcommands(counting.counters)).not.toContain("switch");
      });
    });
  }

  /**
   * A retained Worktree identity is a name *and* the place that name is given.
   *
   * Placement is a function of identity, so the two travel together and have to
   * still be the pair placement produces. A result naming one Worktree at
   * another's path, or at a path no name is given, describes a checkout this run
   * never had — and nothing about the shape of it says so.
   */
  const WORKTREE_DAMAGE: { name: string; damage: (record: Record<string, unknown>) => void }[] = [
    {
      name: "names a Worktree that is not the one placed at its path",
      damage: (record) => {
        Object(record.checkout).worktreeName = "forged";
      },
    },
    {
      name: "names a path this run's placement gives no Worktree",
      damage: (record) => {
        Object(record.checkout).checkoutPath = "/worktrees";
      },
    },
  ];

  for (const { name, damage } of WORKTREE_DAMAGE) {
    it(`fails a replay whose retained result ${name}`, function* () {
      const root = yield* useStorageRoot();
      const remote = yield* useBareRemote(REMOTE);
      const path = runPath(root, "release-1.4");

      yield* withStorage(root, function* () {
        const database = yield* createRun();
        expect(String(yield* runDocument(database, worktreeSource(remote.locator)))).toContain(
          "after: release",
        );

        dropRootClose(path);
        damageSwitchResult(path, damage);

        const counting = countingHost();
        const failure = yield* raised(
          runDocument(database, worktreeSource(remote.locator), countingOptions(counting)),
        );

        expect(causedBy(failure, isProtocolFailure)).toBeInstanceOf(GitOperationProtocolError);
        expect(subcommands(counting.counters)).not.toContain("switch");
      });
    });
  }

  it("fails a replay whose no-op transition staged something", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, "release-1.4");

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      // Switching to the branch the checkout is already on moves nothing, so a
      // retained index digest that changed across it is describing a transition
      // this component does not make.
      expect(String(yield* runDocument(database, unchangedSource(remote.locator)))).toContain(
        "after: main",
      );
      const [outcome] = yield* gitOutcomes(database);
      const before = Object(Reflect.get(Object(outcome?.record), "before"));
      const after = Object(Reflect.get(Object(outcome?.record), "after"));
      expect(before.branch).toBe(after.branch);
      expect(before.indexTree).toBe(after.indexTree);

      dropRootClose(path);
      damageSwitchResult(path, (record) => {
        Object(record.after).indexTree = "0".repeat(40);
      });

      const counting = countingHost();
      const failure = yield* raised(
        runDocument(database, unchangedSource(remote.locator), countingOptions(counting)),
      );

      expect(causedBy(failure, isProtocolFailure)).toBeInstanceOf(GitOperationProtocolError);
      expect(subcommands(counting.counters)).not.toContain("switch");
    });
  });

  /**
   * A recorded transition belongs to the observation it was authorized for.
   *
   * Durable identity is type and name, and the name is where the observation
   * lives, so the encoding behind it has to be injective: two records that
   * digested alike would let a replay hand back a transition authorized for one
   * of them to the other, on the path where nothing is authenticated because
   * nothing is executed.
   *
   * `requestedBase` is the demonstration. A record that never supplied a base
   * retains `null`; a replaced context can supply the string a sentinel-based
   * encoding used for absence, and the two must still be different effects.
   */
  it("refuses to replay a transition recorded for a different Repository record", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, "release-1.4");

    yield* withStorage(root, function* () {
      // What this fixture retains, learned from a run of its own: creation
      // identity is a function of the name, the url and the base.
      const learning = yield* createRun({ runId: "learning" });
      yield* runDocument(learning, `<Repository name="project" url="${remote.locator}" as="r" />`);
      const [learned] = yield* retainedRepositories(learning);
      const record = learned?.record;
      if (record === undefined || record.requestedBase !== null) {
        throw new Error("the fixture did not retain a Repository with no requested base");
      }

      const database = yield* createRun();
      const first = countingHost();
      yield* runObserved(database, record, remote.locator, countingOptions(first));
      expect(subcommands(first.counters)).toContain("switch");
      const recorded = yield* gitEvents(database);
      expect(recorded).toHaveLength(1);
      const published = publishedRoots(path);

      dropRootClose(path);

      // The same expansion, under a context differing in one member only.
      const second = countingHost();
      const failure = yield* raised(
        runObserved(
          database,
          { ...record, requestedBase: "\u0000" },
          remote.locator,
          countingOptions(second),
        ),
      );

      // Two different effects, so the recorded one is not this one's to take:
      // the journal says so at the position it reaches, before anything runs.
      // A collision would instead have handed this observation a transition
      // recorded for another, on the path where nothing is authenticated
      // because nothing is executed.
      expect(causedBy(failure, isDivergence)).toBeInstanceOf(DivergenceError);
      expect(causedBy(failure, isGitFailure)).toBe(undefined);
      expect(subcommands(second.counters)).not.toContain("switch");
      expect(yield* gitEvents(database)).toHaveLength(recorded.length);
      expect(publishedRoots(path)).toBe(published);
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
/**
 * The encoding behind a Git operation's durable identity, on its own.
 *
 * The replay above proves one collision cannot happen; this proves the shape of
 * the encoding, which is what makes every other arrangement of values safe too.
 * Absence, a separator, a length prefix and the empty string are all ordinary
 * content somewhere — a branch may be named `1:a`, a base may contain any
 * character — so none of them may be readable as structure. Nor may any of them
 * be *lost*: an unpaired surrogate is a string a document can hold, and a digest
 * taken over UTF-8 would collapse it onto U+FFFD.
 */
describe("workflow Git operation identity", () => {
  it("gives distinct values distinct fingerprints", function* () {
    const arrangements: (string | null)[][] = [
      [],
      [null],
      [""],
      ["\u0000"],
      ["\u0001"],
      ["-"],
      [null, null],
      [null, ""],
      ["", null],
      ["a", "b"],
      ["a\u0001b"],
      ["ab", ""],
      ["", "ab"],
      ["1:a"],
      ["1", "a"],
      ["2:ab", "c"],
      ["2:ab c"],
      ["main", null],
      [null, "main"],
      // A JavaScript string is code units, not text. An unpaired surrogate is a
      // value a document can hold, and encoding one as UTF-8 would replace it
      // with the character below.
      ["\ud800"],
      ["\udc00"],
      ["\ufffd"],
      ["a\ud800b"],
      ["a\ufffdb"],
    ];

    const fingerprints = arrangements.map((values) => gitOperationFingerprint(values));
    expect(new Set(fingerprints).size).toBe(arrangements.length);
  });

  it("gives one value one fingerprint", function* () {
    expect(gitOperationFingerprint(["main", null, "a\u0001b"])).toBe(
      gitOperationFingerprint(["main", null, "a\u0001b"]),
    );
  });
});

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

    // Sampled once, immediately, and deliberately: teardown waits for the
    // child to close, so by the time `halt()` has returned there is nothing
    // left holding the read end. A cleanup that only signalled would still be
    // racing here, and this write would land in the pipe.
    const refused = yield* raised(until(writer.write("content")));
    yield* until(writer.close());
    expect(Reflect.get(Object(refused), "code")).toBe("EPIPE");
  });
});
