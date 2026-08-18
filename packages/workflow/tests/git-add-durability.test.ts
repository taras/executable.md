/**
 * Tier WF — what a `<Git.Add>` retains, replays and refuses to guess.
 *
 * The claims here are about the run's database rather than about an index. A
 * replay must stage nothing and append no second transition; a retained result
 * that no longer describes the invocation it was recorded for must stop the run;
 * a cancelled or unretainable staging must leave the frontier exactly as it was.
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
import type { Json } from "@executablemd/durable-streams";
import { cwd } from "@executablemd/runtime";
import {
  GitOperationAuthorityError,
  GitOperationError,
  GitOperationProtocolError,
} from "../src/composition/errors.ts";
import { currentRepository } from "../src/composition/context.ts";
import { GitComposition } from "../src/composition/git-api.ts";
import type { RepositoryRecord } from "../src/composition/records.ts";
import { WORKSPACE_GIT_ADD } from "../src/deno/composition/provider.ts";
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

const REMOTE = {
  commits: [
    {
      message: "first",
      entries: [
        { path: "which.txt", content: "main\n" },
        { path: "nested/note.md", content: "note\n" },
        { path: ".gitignore", content: "ignored.txt\n" },
      ],
    },
  ],
} as const;

const PATHS = ["which.txt", "added.txt"] as const;

function source(locator: string): string {
  return [
    `<Repository name="project" url="${locator}">`,
    `<File path="added.txt">`,
    "fresh",
    "</File>",
    `<Git.Add paths={${JSON.stringify(PATHS)}} />`,
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

/** Damage the one retained add result, refusing to continue if it damaged none. */
function damageAddResult(path: string, damage: (record: Record<string, unknown>) => void): void {
  let rewritten = 0;
  tamper(path, (database) => {
    for (const row of database.prepare("SELECT sequence, record FROM journal_events").all()) {
      const parsed: unknown = JSON.parse(String(row["record"]));
      const description = Object(Reflect.get(Object(parsed), "description"));
      if (Reflect.get(description, "type") !== WORKSPACE_GIT_ADD) {
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
    throw new Error(`the journal holds ${rewritten} add results`);
  }
}

describe("workflow Git.Add durability", () => {
  it("replays without staging again or appending a second transition", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, "release-1.4");

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runDocument(database, source(remote.locator));
      const before = yield* gitEvents(database);
      expect(before).toHaveLength(1);
      const staged = yield* stagedPaths(database, yield* checkoutOf(database));
      const published = publishedRoots(path);

      dropRootClose(path);
      yield* remote.remove();

      const counting = countingHost();
      yield* runDocument(database, source(remote.locator), countingOptions(counting));

      expect(subcommands(counting.counters)).not.toContain("add");
      expect(yield* gitEvents(database)).toHaveLength(1);
      expect(publishedRoots(path)).toBe(published);
      expect(yield* stagedPaths(database, yield* checkoutOf(database))).toEqual(staged);
      expect(yield* survivingRoots(counting.counters)).toEqual([]);
    });
  });

  it("retains a staging that changed nothing", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      // Staging a tracked file nothing has touched is a run that happened and
      // moved no index, which the protocol allows and the result says.
      yield* runDocument(
        database,
        [
          `<Repository name="project" url="${remote.locator}">`,
          `<Git.Add paths="which.txt" />`,
          "</Repository>",
        ].join("\n"),
      );

      const [outcome] = yield* gitOutcomes(database);
      expect(outcome?.status).toBe("ok");
      const record = Object(outcome?.record);
      expect(Object(record.before).indexTree).toBe(Object(record.after).indexTree);
      expect(yield* stagedPaths(database, yield* checkoutOf(database))).toEqual([]);
    });
  });

  /**
   * Every way a retained add result can stop describing its invocation.
   *
   * Shape, then meaning: an object id that is not one, a checkout that is not
   * the one this request selects or is not where placement puts it, pathspecs
   * that are not the ones the document wrote, and a transition staging cannot
   * make — `git add` moves the index and leaves the branch, the commit and the
   * HEAD tree exactly where it found them.
   */
  const DAMAGE: { name: string; damage: (record: Record<string, unknown>) => void }[] = [
    {
      name: "is missing a member the protocol declares",
      damage: (record) => {
        delete record.paths;
      },
    },
    {
      name: "carries more than the protocol declares",
      damage: (record) => {
        record.staged = ["which.txt"];
      },
    },
    {
      name: "holds something that is not an object id",
      damage: (record) => {
        Object(record.after).indexTree = "not-an-oid";
      },
    },
    {
      name: "holds an object id in the wrong case",
      damage: (record) => {
        Object(record.after).indexTree = String(Object(record.after).indexTree).toUpperCase();
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
      name: "names a Worktree this run's placement does not put there",
      damage: (record) => {
        Object(record.checkout).worktreeName = "forged";
      },
    },
    {
      name: "reorders the pathspecs the document wrote",
      damage: (record) => {
        record.paths = [...PATHS].reverse();
      },
    },
    {
      name: "drops a pathspec the document wrote",
      damage: (record) => {
        record.paths = [PATHS[0]];
      },
    },
    {
      name: "adds a pathspec the document did not write",
      damage: (record) => {
        record.paths = [...PATHS, "nested/note.md"];
      },
    },
    {
      name: "respells a pathspec the document wrote",
      damage: (record) => {
        record.paths = [PATHS[0], "./added.txt"];
      },
    },
    {
      name: "holds no pathspecs at all",
      damage: (record) => {
        record.paths = [];
      },
    },
    {
      name: "claims the branch moved",
      damage: (record) => {
        Object(record.after).branch = "other";
      },
    },
    {
      name: "claims the commit moved",
      damage: (record) => {
        Object(record.after).commit = Object(record.after).headTree;
      },
    },
    {
      name: "claims the HEAD tree moved",
      damage: (record) => {
        Object(record.after).headTree = Object(record.after).indexTree;
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
        damageAddResult(path, damage);

        const counting = countingHost();
        const failure = yield* raised(
          runDocument(database, source(remote.locator), countingOptions(counting)),
        );

        expect(causedBy(failure, isProtocolFailure)).toBeInstanceOf(GitOperationProtocolError);
        expect(subcommands(counting.counters)).not.toContain("add");
      });
    });
  }

  /**
   * A refusal is one failed durable outcome, and replaying it repeats nothing.
   *
   * The ignored-path case is the sharp one: native Git stages what it matched
   * before refusing, so what makes this all-or-none is the effect — the throw
   * lands before anything is imported, the materialization goes with the scope,
   * and the failed result describes a root that did not move.
   */
  it("publishes one failed result against the unchanged root, and replays it", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, "release-1.4");

    const refused = [
      `<Repository name="project" url="${remote.locator}">`,
      `<File path="added.txt">`,
      "fresh",
      "</File>",
      `<File path="ignored.txt">`,
      "ignored content",
      "</File>",
      `<Git.Add paths={["added.txt", "ignored.txt"]} />`,
      "</Repository>",
    ].join("\n");

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const live = countingHost();
      const failure = yield* raised(runDocument(database, refused, countingOptions(live)));

      expect(causedBy(failure, isGitFailure)?.reason).toBe("ignored-pathspec");
      expect(subcommands(live.counters)).toContain("add");

      // One failed outcome, the root where the file writes left it, and no
      // trace of what the command had already applied.
      const [outcome] = yield* gitOutcomes(database);
      expect(outcome?.status).toBe("err");
      expect(committedRoot(path)).toBe(latestRoot(path));
      expect(yield* stagedPaths(database, yield* checkoutOf(database))).toEqual([]);

      // Nothing Git printed, nowhere it ran, and nothing it found.
      const retained = `${outcome?.name} ${outcome?.message}`;
      expect(retained).toContain("ignored-pathspec");
      expect(retained).not.toContain("ignored.txt");
      expect(retained).not.toContain("gitignore");
      expect(retained).not.toContain("hint:");
      expect(retained).not.toContain(tmpdir());
      for (const materialization of live.counters.roots) {
        expect(retained).not.toContain(materialization);
      }

      const published = publishedRoots(path);
      dropRootClose(path);
      yield* remote.remove();

      const replayed = countingHost();
      const again = yield* raised(runDocument(database, refused, countingOptions(replayed)));

      // The same refusal, assembled from what the journal holds.
      expect(causedBy(again, isGitFailure)?.reason).toBe("ignored-pathspec");
      expect(String(causedBy(again, isGitFailure))).toBe(String(causedBy(failure, isGitFailure)));
      expect(subcommands(replayed.counters)).not.toContain("add");
      expect(yield* gitEvents(database)).toHaveLength(1);
      expect(publishedRoots(path)).toBe(published);
      expect(yield* stagedPaths(database, yield* checkoutOf(database))).toEqual([]);
    });
  });

  it("leaves the frontier untouched when a blocked staging is halted", function* () {
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
          if (invocation.args[0] === "add") {
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

      expect(yield* retainedRepositories(database)).toHaveLength(1);
      expect(yield* gitEvents(database)).toHaveLength(0);
      expect(committedRoot(path)).toBe(latestRoot(path));
      expect(yield* stagedPaths(database, yield* checkoutOf(database))).toEqual([]);
      expect(yield* survivingRoots({ commands: [], roots, effects: [], attachments: [] })).toEqual(
        [],
      );
    });
  });

  it("retains neither the staging nor a result when the import fails", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    // The Repository's own import writes the checkout's index once. The second
    // write of it is the staging being imported, which this run cannot retain.
    let imports = 0;

    yield* withStorage(
      root,
      function* () {
        const database = yield* createRun();
        const failure = yield* raised(runDocument(database, source(remote.locator)));

        expect(failure).not.toBe(undefined);
        expect(yield* gitEvents(database)).toHaveLength(0);
        expect(yield* stagedPaths(database, yield* checkoutOf(database))).toEqual([]);
        expect(imports).toBeGreaterThan(1);
      },
      {
        decorateFilesystem: (filesystem: DenoWorkspaceFilesystem) => ({
          ...filesystem,
          *writeFile(target: string, content: string | Uint8Array, mode?: number) {
            if (target.endsWith("/.git/index")) {
              imports += 1;
              if (imports > 1) {
                return throwWorkspaceFilesystemFailure(
                  Object.assign(new Error("refused"), {
                    name: "WorkspaceFsError",
                    code: "EACCES",
                  }),
                );
              }
            }
            yield* filesystem.writeFile(target, content, mode);
          },
        }),
      },
    );
  });

  it("retains no host path and adds no table", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const untouched = yield* createRun({ runId: "untouched" });
      yield* runDocument(
        untouched,
        `<Repository name="project" url="${remote.locator}" as="repository" />`,
      );

      const staged = yield* createRun({ runId: "staged" });
      const counting = countingHost();
      yield* runDocument(staged, source(remote.locator), countingOptions(counting));

      expect(tableNames(runPath(root, "staged"))).toEqual(tableNames(runPath(root, "untouched")));

      // Creation identity does not move when an index does.
      const [before] = yield* retainedRepositories(untouched);
      const [after] = yield* retainedRepositories(staged);
      expect(after?.record).toEqual(before?.record);

      const [outcome] = yield* gitOutcomes(staged);
      const retained = JSON.stringify(outcome?.record);
      for (const materialization of counting.counters.roots) {
        expect(retained).not.toContain(materialization);
      }
      expect(retained).not.toContain(tmpdir());
      // The pathspecs are retained; what Git found beyond them is not.
      expect(retained).toContain("added.txt");
      expect(retained).not.toContain("nested/note.md");
    });
  });
});

describe("workflow Git.Add composition routing", () => {
  it("routes a loaded copy's Api to the installed provider without sharing authority", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const copy = yield* physicalGitApiCopy();
    expect(copy.GitComposition).not.toBe(GitComposition);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* scoped(function* () {
        return yield* withWorkflowWorkspace(
          database,
          scoped(function* () {
            yield* registerComponents([probe(copy, (repository) => repository)]);
            return yield* collect(
              yield* execute({
                ...inlineSource(
                  [
                    `<Repository name="project" url="${remote.locator}">`,
                    `<File path="added.txt">`,
                    "fresh",
                    "</File>",
                    "<Probe />",
                    "</Repository>",
                  ].join("\n"),
                ),
                stream: database.journal,
              }),
            );
          }),
        );
      });

      expect(yield* stagedPaths(database, yield* checkoutOf(database))).toEqual(["added.txt"]);
      expect((yield* gitOutcomes(database)).map((outcome) => outcome.status)).toEqual(["ok"]);

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
                yield* execute({
                  ...inlineSource(
                    [
                      `<Repository name="project" url="${remote.locator}">`,
                      "<Probe />",
                      "</Repository>",
                    ].join("\n"),
                  ),
                  stream: forged.journal,
                }),
              );
            }),
          );
        }),
      );

      expect(causedBy(failure, isAuthorityFailure)).toBeInstanceOf(GitOperationAuthorityError);
      expect(yield* gitEvents(forged)).toHaveLength(0);
    });
  });
});

/** A component that stages through a loaded copy's Api, on a chosen record. */
function probe(
  copy: LoadedGitApi,
  observe: (repository: RepositoryRecord) => RepositoryRecord,
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
      yield* copy.GitComposition.operations.addPaths({
        repository: observe(repository),
        workingDirectory: yield* cwd(),
        paths: ["added.txt"],
      });
      return "";
    },
  };
}

/** The primary checkout's Workspace path, once this run has retained one. */
function* checkoutOf(database: WorkflowRunDatabase): Operation<string> {
  const [repository] = yield* retainedRepositories(database);
  if (repository === undefined) {
    throw new Error("the run retained no repository");
  }
  return repository.record.checkoutPath;
}
