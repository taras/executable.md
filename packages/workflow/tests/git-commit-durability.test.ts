/**
 * Tier WF — what a `<Git.Commit>` retains, replays and refuses to guess.
 *
 * The claims here are about the run's database rather than about a repository. A
 * replay must write no object, read no clock and append no second transition; a
 * retained result that no longer describes the invocation it was recorded for
 * must stop the run; a cancelled or unretainable commit must leave the frontier
 * exactly as it was.
 *
 * Every replay happens after the remote is deleted, so what continues a run is
 * what the run retained or nothing does.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { scoped, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import { collect, execute, inlineSource, registerComponents } from "@executablemd/core";
import type { ComponentRegistration } from "@executablemd/core";
import { cwd } from "@executablemd/runtime";
import {
  GitOperationAuthorityError,
  GitOperationError,
  GitOperationProtocolError,
} from "../src/composition/errors.ts";
import { currentRepository } from "../src/composition/context.ts";
import { GitComposition } from "../src/composition/git-api.ts";
import type { RepositoryRecord } from "../src/composition/records.ts";
import { WORKSPACE_GIT_COMMIT } from "../src/deno/composition/provider.ts";
import { denoRepositoryHost } from "../src/deno/composition/host.ts";
import type { GitInvocation, GitOutcome } from "../src/deno/composition/host.ts";
import { throwWorkspaceFilesystemFailure } from "../src/deno/workspace/errors.ts";
import type { DenoWorkspaceFilesystem } from "../src/deno/workspace/filesystem.ts";
import { withWorkflowWorkspace } from "../src/deno/workspace/host.ts";
import type { WorkflowRunDatabase } from "../src/storage/api.ts";
import { createRun, runPath, tamper, useStorageRoot, withStorage } from "./support/storage.ts";
import { useBareRemote } from "./support/git-remotes.ts";
import {
  causedBy,
  countingHost,
  countingOptions,
  gitEvents,
  gitOutcomes,
  headCommit,
  physicalGitApiCopy,
  raised,
  retainedRepositories,
  runDocument,
  stagedPaths,
  subcommands,
  survivingRoots,
} from "./support/composition.ts";
import type { LoadedGitApi } from "./support/composition.ts";
import { committedRoot, dropRootClose, latestRoot, publishedRoots } from "./support/replay.ts";

import type { RepositorySelection } from "../src/composition/selection.ts";
const REMOTE = {
  commits: [{ message: "first", entries: [{ path: "which.txt", content: "main\n" }] }],
} as const;

const MESSAGE = "record what was staged";

function source(locator: string): string {
  return [
    `<Repository name="project" url="${locator}">`,
    `<File path="added.txt">`,
    "fresh",
    "</File>",
    `<Git.Commit message="${MESSAGE}" as="sha">`,
    `<Git.Add paths="added.txt" />`,
    "</Git.Commit>",
    "",
    "sha: {sha}",
    "</Repository>",
  ].join("\n");
}

/** A commit with nothing staged for it, which is the one refusal it speaks. */
function unstaged(locator: string): string {
  return [
    `<Repository name="project" url="${locator}">`,
    `<Git.Commit message="nothing staged" as="sha" />`,
    "</Repository>",
  ].join("\n");
}

function isProtocolFailure(value: unknown): value is GitOperationProtocolError {
  return value instanceof GitOperationProtocolError;
}

function isAuthorityFailure(value: unknown): value is GitOperationAuthorityError {
  return value instanceof GitOperationAuthorityError;
}

function isGitFailure(value: unknown): value is GitOperationError {
  return value instanceof GitOperationError;
}

function* checkoutOf(database: WorkflowRunDatabase): Operation<string> {
  const [repository] = yield* retainedRepositories(database);
  if (repository === undefined) {
    throw new Error("the run retained no repository");
  }
  return repository.record.checkoutPath;
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

/** Damage the one retained commit result, refusing to continue if it damaged none. */
function damageCommitResult(path: string, damage: (record: Record<string, unknown>) => void): void {
  let rewritten = 0;
  tamper(path, (database) => {
    for (const row of database.prepare("SELECT sequence, record FROM journal_events").all()) {
      const parsed: unknown = JSON.parse(String(row["record"]));
      const description = Object(Reflect.get(Object(parsed), "description"));
      if (Reflect.get(description, "type") !== WORKSPACE_GIT_COMMIT) {
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
    throw new Error(`the journal holds ${rewritten} commit results`);
  }
}

describe("workflow Git.Commit durability", () => {
  it("replays without writing an object, reading a clock or appending a transition", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, "release-1.4");

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const first = String(yield* runDocument(database, source(remote.locator)));
      const object = yield* headCommit(database, yield* checkoutOf(database));
      expect(first).toContain(`sha: ${object.commit}`);
      expect(yield* gitEvents(database)).toHaveLength(2);
      const published = publishedRoots(path);

      dropRootClose(path);
      yield* remote.remove();

      const counting = countingHost();
      const again = String(
        yield* runDocument(database, source(remote.locator), countingOptions(counting)),
      );

      // The same SHA, from the journal, with no Git and no second transition.
      expect(again).toContain(`sha: ${object.commit}`);
      expect(subcommands(counting.counters)).not.toContain("commit");
      expect(yield* gitEvents(database)).toHaveLength(2);
      expect(publishedRoots(path)).toBe(published);
      expect((yield* headCommit(database, yield* checkoutOf(database))).commit).toBe(object.commit);
      expect(yield* survivingRoots(counting.counters)).toEqual([]);
    });
  });

  /**
   * Every way a retained commit result can stop describing its invocation.
   *
   * Shape, then meaning: an object id that is not one, a checkout that is not
   * the one this request selects, message evidence that is not the evidence of
   * what was composed, and an object graph a commit of the index cannot have —
   * one parent, which is where the checkout was, and a tree that is what the
   * index described and what both HEAD and the index describe afterwards.
   */
  const DAMAGE: { name: string; damage: (record: Record<string, unknown>) => void }[] = [
    {
      name: "is missing a member the protocol declares",
      damage: (record) => {
        delete record.tree;
      },
    },
    {
      name: "carries more than the protocol declares",
      damage: (record) => {
        record.signed = false;
      },
    },
    {
      name: "holds something that is not an object id",
      damage: (record) => {
        record.commit = "not-an-oid";
      },
    },
    {
      name: "holds an object id in the wrong case",
      damage: (record) => {
        record.commit = String(record.commit).toUpperCase();
        Object(record.after).commit = String(record.commit);
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
      name: "claims another message source",
      damage: (record) => {
        record.messageSource = "children";
      },
    },
    {
      name: "claims a digest of other bytes",
      damage: (record) => {
        record.messageDigest = "0".repeat(64);
      },
    },
    {
      name: "claims another byte length",
      damage: (record) => {
        record.messageLength = Number(record.messageLength) + 1;
      },
    },
    {
      name: "continues a commit the checkout was not on",
      damage: (record) => {
        record.parent = String(Object(record.before).indexTree);
      },
    },
    {
      name: "holds a tree the index did not describe",
      damage: (record) => {
        record.tree = String(Object(record.before).headTree);
      },
    },
    {
      name: "is not the commit the checkout ended on",
      damage: (record) => {
        Object(record.after).commit = String(Object(record.before).commit);
      },
    },
    {
      name: "left HEAD describing another tree",
      damage: (record) => {
        Object(record.after).headTree = String(Object(record.before).headTree);
      },
    },
    {
      name: "left the index describing another tree",
      damage: (record) => {
        Object(record.after).indexTree = String(Object(record.before).headTree);
      },
    },
    {
      name: "ends on a branch the checkout did not begin on",
      damage: (record) => {
        Object(record.after).branch = "other";
      },
    },
    {
      name: "committed an index that already matched HEAD",
      damage: (record) => {
        Object(record.before).indexTree = String(Object(record.before).headTree);
      },
    },
    {
      name: "was recorded at no whole second",
      damage: (record) => {
        record.committedAt = -1;
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
        damageCommitResult(path, damage);
        yield* remote.remove();

        const counting = countingHost();
        const failure = yield* raised(
          runDocument(database, source(remote.locator), countingOptions(counting)),
        );

        expect(causedBy(failure, isProtocolFailure)).toBeInstanceOf(GitOperationProtocolError);
        expect(subcommands(counting.counters)).not.toContain("commit");
      });
    });
  }

  /**
   * A refusal is one failed durable outcome, and replaying it repeats nothing.
   *
   * An index that already matches HEAD is decided from the checkout's own state,
   * so no command runs and no object is written — and the failed result
   * describes a Workspace root that did not move.
   */
  it("publishes one failed result against the unchanged root, and replays it", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, "release-1.4");

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const live = countingHost();
      const failure = yield* raised(
        runDocument(database, unstaged(remote.locator), countingOptions(live)),
      );

      expect(causedBy(failure, isGitFailure)?.reason).toBe("empty-index");
      expect(subcommands(live.counters)).not.toContain("commit");

      const [outcome] = yield* gitOutcomes(database);
      expect(outcome?.status).toBe("err");
      expect(committedRoot(path)).toBe(latestRoot(path));

      // Nothing Git printed, nowhere it ran.
      const retained = `${outcome?.name} ${outcome?.message}`;
      expect(retained).toContain("empty-index");
      expect(retained).not.toContain("nothing to commit");
      expect(retained).not.toContain(tmpdir());
      for (const materialization of live.counters.roots) {
        expect(retained).not.toContain(materialization);
      }

      const published = publishedRoots(path);
      dropRootClose(path);
      yield* remote.remove();

      const replayed = countingHost();
      const again = yield* raised(
        runDocument(database, unstaged(remote.locator), countingOptions(replayed)),
      );

      expect(causedBy(again, isGitFailure)?.reason).toBe("empty-index");
      expect(String(causedBy(again, isGitFailure))).toBe(String(causedBy(failure, isGitFailure)));
      expect(subcommands(replayed.counters)).not.toContain("commit");
      expect(yield* gitEvents(database)).toHaveLength(1);
      expect(publishedRoots(path)).toBe(published);
    });
  });

  it("leaves the frontier untouched when a blocked commit is halted", function* () {
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
          if (invocation.args[0] === "commit") {
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

      // The staging committed in its own effect; the commit published nothing.
      expect(
        (yield* gitEvents(database)).map((event) =>
          event.type === "yield" ? event.description.type : "",
        ),
      ).toEqual(["workspace_git_add"]);
      expect(committedRoot(path)).toBe(latestRoot(path));
      expect((yield* headCommit(database, yield* checkoutOf(database))).message).toBe("first\n");
      expect(yield* stagedPaths(database, yield* checkoutOf(database))).toEqual(["added.txt"]);
      expect(yield* survivingRoots({ commands: [], roots, effects: [], attachments: [] })).toEqual(
        [],
      );
    });
  });

  it("retains neither the commit nor a result when the import fails", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    // Only a commit writes this file, so failing on it fails exactly the import
    // of what native Git had just produced.
    let refused = 0;

    yield* withStorage(
      root,
      function* () {
        const database = yield* createRun();
        const failure = yield* raised(runDocument(database, source(remote.locator)));

        expect(failure).not.toBe(undefined);
        expect(refused).toBe(1);
        expect(
          (yield* gitEvents(database)).map((event) =>
            event.type === "yield" ? event.description.type : "",
          ),
        ).toEqual(["workspace_git_add"]);
        expect((yield* headCommit(database, yield* checkoutOf(database))).message).toBe("first\n");
      },
      {
        decorateFilesystem: (filesystem: DenoWorkspaceFilesystem) => ({
          ...filesystem,
          *writeFile(target: string, content: string | Uint8Array, mode?: number) {
            if (target.endsWith("/.git/COMMIT_EDITMSG")) {
              refused += 1;
              return throwWorkspaceFilesystemFailure(
                Object.assign(new Error("refused"), {
                  name: "WorkspaceFsError",
                  code: "EACCES",
                }),
              );
            }
            yield* filesystem.writeFile(target, content, mode);
          },
        }),
      },
    );
  });

  it("retains no host path, no message text and no new table", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const untouched = yield* createRun({ runId: "untouched" });
      yield* runDocument(
        untouched,
        `<Repository name="project" url="${remote.locator}" as="repository" />`,
      );

      const recorded = yield* createRun({ runId: "recorded" });
      const counting = countingHost();
      yield* runDocument(recorded, source(remote.locator), countingOptions(counting));

      expect(tableNames(runPath(root, "recorded"))).toEqual(tableNames(runPath(root, "untouched")));

      // Creation identity does not move when a branch tip does.
      const [before] = yield* retainedRepositories(untouched);
      const [after] = yield* retainedRepositories(recorded);
      expect(after?.record).toEqual(before?.record);

      const [, outcome] = yield* gitOutcomes(recorded);
      const retained = JSON.stringify(outcome?.record);
      for (const materialization of counting.counters.roots) {
        expect(retained).not.toContain(materialization);
      }
      expect(retained).not.toContain(tmpdir());
      // The message is described rather than kept.
      expect(retained).not.toContain(MESSAGE);
      expect(retained).toContain("messageDigest");
    });
  });
});

describe("workflow Git.Commit composition routing", () => {
  it("routes a loaded copy's Api to the installed provider without sharing authority", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const copy = yield* physicalGitApiCopy();
    expect(copy.GitComposition).not.toBe(GitComposition);

    const staged = [
      `<Repository name="project" url="${remote.locator}">`,
      `<File path="added.txt">`,
      "fresh",
      "</File>",
      `<Git.Add paths="added.txt" />`,
      "<Probe />",
      "</Repository>",
    ].join("\n");

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* scoped(function* () {
        return yield* withWorkflowWorkspace(
          database,
          scoped(function* () {
            yield* registerComponents([probe(copy, (repository) => repository)]);
            return yield* collect(
              yield* execute({ ...inlineSource(staged), stream: database.journal }),
            );
          }),
        );
      });

      expect((yield* headCommit(database, yield* checkoutOf(database))).message).toBe(
        "through a loaded copy\n",
      );
      expect((yield* gitOutcomes(database)).map((outcome) => outcome.status)).toEqual(["ok", "ok"]);

      const forged = yield* createRun({ runId: "loaded-copy-forged" });
      const failure = yield* raised(
        scoped(function* () {
          return yield* withWorkflowWorkspace(
            forged,
            scoped(function* () {
              yield* registerComponents([
                probe(copy, (repository) => ({ ...repository, name: "ghost" })),
              ]);
              return yield* collect(
                yield* execute({ ...inlineSource(staged), stream: forged.journal }),
              );
            }),
          );
        }),
      );

      expect(causedBy(failure, isAuthorityFailure)).toBeInstanceOf(GitOperationAuthorityError);
      expect(
        (yield* gitEvents(forged)).map((event) =>
          event.type === "yield" ? event.description.type : "",
        ),
      ).toEqual(["workspace_git_add"]);
    });
  });
});

/** A component that commits through a loaded copy's Api, on a chosen record. */
function probe(
  copy: LoadedGitApi,
  observe: (repository: RepositorySelection) => RepositorySelection,
): ComponentRegistration {
  return {
    name: "Probe",
    origin: "test",
    props: { type: "object", additionalProperties: false },
    *fn(): Operation<string> {
      const repository = yield* currentRepository();
      if (repository === undefined) {
        throw new Error("the probe was written outside a Repository");
      }
      yield* copy.GitComposition.operations.commitIndex({
        repository: observe(repository),
        workingDirectory: yield* cwd(),
        message: "through a loaded copy\n",
        messageSource: "prop",
      });
      return "";
    },
  };
}
