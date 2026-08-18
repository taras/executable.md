/**
 * Tier WF — `<Git.Add>` as a document writes it.
 *
 * What is under test is staging that survives in the run's own Workspace: which
 * pathspecs Git received, which checkout received them, and which directory it
 * read them relative to. The discriminating observation is the retained
 * checkout's index, read back through a disposable export the way the provider
 * reads it — an index-tree digest says something changed, and only the index
 * says what.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { registerComponents } from "@executablemd/core";
import { collect, execute, inlineSource } from "@executablemd/core";
import type { ComponentRegistration } from "@executablemd/core";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { scoped, until } from "effection";
import type { Operation } from "effection";
import { readTextFile, writeTextFile } from "@effectionx/fs";
import { pathToFileURL } from "node:url";
import { cwd } from "@executablemd/runtime";
import { useTempDirectory } from "@executablemd/test-support/temp";
import {
  GitCompositionProviderError,
  GitOperationAuthorityError,
  GitOperationError,
} from "../src/composition/errors.ts";
import { currentRepository, RepositoryContext } from "../src/composition/context.ts";
import { GitComposition } from "../src/composition/git-api.ts";
import { parseGitAddResult } from "../src/composition/git-records.ts";
import type { GitAddExpectation } from "../src/composition/git-records.ts";
import { useCompositionComponents } from "../src/composition/installation.ts";
import { canonicalPaths } from "../src/composition/components/GitAdd.ts";
import type { RepositoryRecord } from "../src/composition/records.ts";
import { denoRepositoryHost } from "../src/deno/composition/host.ts";
import type { GitInvocation, GitOutcome } from "../src/deno/composition/host.ts";
import { withWorkflowWorkspace } from "../src/deno/workspace/host.ts";
import type { WorkflowWorkspaceOptions } from "../src/deno/workspace/host.ts";
import type { WorkflowRunDatabase } from "../src/storage/api.ts";
import { createRun, useStorageRoot, withStorage } from "./support/storage.ts";
import { useBareRemote } from "./support/git-remotes.ts";
import {
  causedBy,
  countingHost,
  countingOptions,
  gitEvents,
  gitOutcomes,
  raised,
  removeWorkspacePath,
  retainedRepositories,
  retainedWorktrees,
  runDocument,
  stagedPaths,
  subcommands,
} from "./support/composition.ts";

/**
 * A tracked file at the root, one in a subdirectory, and one more of each.
 *
 * The subdirectory is what makes cwd-relative `"."` a real question: staging
 * from inside it must reach `nested/` and nothing above it.
 */
const REMOTE = {
  commits: [
    {
      message: "first",
      entries: [
        { path: "which.txt", content: "main\n" },
        { path: "shared.txt", content: "shared\n" },
        { path: "nested/note.md", content: "note\n" },
        { path: "nested/deep/leaf.md", content: "leaf\n" },
      ],
    },
  ],
} as const;

const FORGED = Object.freeze({
  name: "ghost",
  locatorFingerprint: "0".repeat(64),
  requestedBase: null,
  creationCommit: "0".repeat(40),
  primaryBranch: "main",
  objectFormat: "sha1" as const,
  checkoutPath: "/repositories/ghost",
});

function isGitFailure(value: unknown): value is GitOperationError {
  return value instanceof GitOperationError;
}

function isAuthorityFailure(value: unknown): value is GitOperationAuthorityError {
  return value instanceof GitOperationAuthorityError;
}

function isProviderError(value: unknown): value is GitCompositionProviderError {
  return value instanceof GitCompositionProviderError;
}

function document(locator: string, ...lines: string[]): string {
  return [`<Repository name="project" url="${locator}">`, ...lines, "</Repository>"].join("\n");
}

/** What a retained result is read back for. */
function* expectation(
  database: WorkflowRunDatabase,
  paths: readonly string[],
  within = "",
): Operation<GitAddExpectation> {
  const [repository] = yield* retainedRepositories(database);
  if (repository === undefined) {
    throw new Error("the run retained no repository to read a result against");
  }
  return {
    repository: repository.record,
    workingDirectory: `${repository.record.checkoutPath}${within}`,
    paths,
  };
}

/**
 * One `<Git.Add>` under a Repository context the run did not install.
 *
 * A self-closing `<Repository>` installs no context, so the record the component
 * observes is exactly the one supplied here — which is what a replaced context
 * is.
 */
function runForged(
  database: WorkflowRunDatabase,
  record: RepositoryRecord,
  source: string,
  options: WorkflowWorkspaceOptions,
): Operation<Json> {
  return scoped(function* () {
    return yield* withWorkflowWorkspace(
      database,
      scoped(function* () {
        yield* RepositoryContext.around({ current: () => record }, { at: "min" });
        return yield* collect(
          yield* execute({ ...inlineSource(source), stream: database.journal }),
        );
      }),
      options,
    );
  });
}

/** The primary checkout's Workspace path, once this run has retained one. */
function* checkout(database: WorkflowRunDatabase): Operation<string> {
  const [repository] = yield* retainedRepositories(database);
  if (repository === undefined) {
    throw new Error("the run retained no repository");
  }
  return repository.record.checkoutPath;
}

describe("workflow Git.Add staging", () => {
  it("stages one pathspec written as a string", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();
      const output = yield* runDocument(
        database,
        document(
          remote.locator,
          `<File path="added.txt">`,
          "fresh",
          "</File>",
          `<Git.Add paths="added.txt" />`,
        ),
        countingOptions(counting),
      );

      // It renders nothing and binds nothing.
      expect(String(output).trim()).toBe("");
      expect(subcommands(counting.counters)).toContain("add");
      expect(counting.counters.effects).toEqual(["repository:project", "git:add"]);
      expect(yield* stagedPaths(database, yield* checkout(database))).toEqual(["added.txt"]);

      const [outcome] = yield* gitOutcomes(database);
      expect(outcome?.status).toBe("ok");
      const retained = parseGitAddResult(
        outcome?.record,
        yield* expectation(database, ["added.txt"]),
      );
      expect(retained?.paths).toEqual(["added.txt"]);
      expect(retained?.checkout.worktreeName).toBe(null);
      // Staging moves the index and nothing else.
      expect(retained?.before.branch).toBe(retained?.after.branch);
      expect(retained?.before.commit).toBe(retained?.after.commit);
      expect(retained?.before.headTree).toBe(retained?.after.headTree);
      expect(retained?.before.indexTree).not.toBe(retained?.after.indexTree);
    });
  });

  it("stages an array in the order it was written, repetitions included", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const paths = ["nested/note.md", "which.txt", "nested/note.md"];
      yield* runDocument(
        database,
        document(
          remote.locator,
          `<File path="which.txt">`,
          "changed",
          "</File>",
          `<File path="nested/note.md">`,
          "revised",
          "</File>",
          `<Git.Add paths={${JSON.stringify(paths)}} />`,
        ),
      );

      expect(yield* stagedPaths(database, yield* checkout(database))).toEqual([
        "nested/note.md",
        "which.txt",
      ]);
      const [outcome] = yield* gitOutcomes(database);
      const retained = parseGitAddResult(outcome?.record, yield* expectation(database, paths));
      // What the document wrote, not what Git made of it.
      expect(retained?.paths).toEqual(paths);
    });
  });

  it("reads a string and its one-element array the same way", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const written = ["string", "array"] as const;
      const trees: string[] = [];
      for (const form of written) {
        const database = yield* createRun({ runId: form });
        yield* runDocument(
          database,
          document(
            remote.locator,
            `<File path="added.txt">`,
            "fresh",
            "</File>",
            form === "string"
              ? `<Git.Add paths="added.txt" />`
              : `<Git.Add paths={["added.txt"]} />`,
          ),
        );
        expect(yield* stagedPaths(database, yield* checkout(database))).toEqual(["added.txt"]);
        const [outcome] = yield* gitOutcomes(database);
        const retained = parseGitAddResult(
          outcome?.record,
          yield* expectation(database, ["added.txt"]),
        );
        expect(retained?.paths).toEqual(["added.txt"]);
        trees.push(String(retained?.after.indexTree));
      }
      expect(trees[0]).toBe(trees[1]);
    });
  });

  it("stages a modification and a deletion", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    // No component deletes a file yet, so the deletion is arranged between two
    // executions of one run. The first execution's staging fails, which retains
    // nothing and leaves the run partial; the Workspace fixture then removes the
    // file, and the identical document runs again — which is also what "the
    // operation may run again from the previous retained root" means.
    const source = document(
      remote.locator,
      `<File path="which.txt">`,
      "changed",
      "</File>",
      `<Git.Add paths={["which.txt", "shared.txt"]} />`,
    );

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const inner = denoRepositoryHost();
      const failing = {
        *git(invocation: GitInvocation): Operation<GitOutcome> {
          if (invocation.args[0] === "add") {
            return { code: 1, stdout: "", stderr: "fatal: a fixture refusal\n" };
          }
          return yield* inner.git(invocation);
        },
        useDirectory: inner.useDirectory,
      };

      expect(
        yield* raised(runDocument(database, source, { composition: { host: failing } })),
      ).not.toBe(undefined);
      expect(yield* gitEvents(database)).toHaveLength(0);

      yield* removeWorkspacePath(database, `${yield* checkout(database)}/shared.txt`);

      const counting = countingHost();
      yield* runDocument(database, source, countingOptions(counting));

      expect(subcommands(counting.counters)).toContain("add");
      expect(yield* stagedPaths(database, yield* checkout(database))).toEqual([
        "shared.txt",
        "which.txt",
      ]);
      expect(yield* gitEvents(database)).toHaveLength(1);
    });
  });

  it("stages only what its pathspecs select", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runDocument(
        database,
        document(
          remote.locator,
          `<File path="which.txt">`,
          "changed",
          "</File>",
          `<File path="shared.txt">`,
          "also changed",
          "</File>",
          `<Git.Add paths="which.txt" />`,
        ),
      );

      expect(yield* stagedPaths(database, yield* checkout(database))).toEqual(["which.txt"]);
    });
  });

  it("reads `.` as the directory the element was written in", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const nested = yield* createRun({ runId: "nested" });
      yield* runDocument(
        nested,
        document(
          remote.locator,
          `<File path="which.txt">`,
          "changed",
          "</File>",
          `<File path="nested/note.md">`,
          "revised",
          "</File>",
          `<Dir path="nested">`,
          `<Git.Add paths="." />`,
          "</Dir>",
        ),
      );

      // The pathspec is relative to the working directory, so the change above
      // the directory is untouched.
      expect(yield* stagedPaths(nested, yield* checkout(nested))).toEqual(["nested/note.md"]);
      const [outcome] = yield* gitOutcomes(nested);
      const retained = parseGitAddResult(
        outcome?.record,
        yield* expectation(nested, ["."], "/nested"),
      );
      expect(retained?.paths).toEqual(["."]);
      // The checkout is the Repository's; the directory is where Git ran.
      expect(retained?.checkout.checkoutPath).toBe(yield* checkout(nested));

      // The same document at the checkout root stages both, which is what makes
      // the reading above a claim about the working directory.
      const rooted = yield* createRun({ runId: "rooted" });
      yield* runDocument(
        rooted,
        document(
          remote.locator,
          `<File path="which.txt">`,
          "changed",
          "</File>",
          `<File path="nested/note.md">`,
          "revised",
          "</File>",
          `<Git.Add paths="." />`,
        ),
      );
      expect(yield* stagedPaths(rooted, yield* checkout(rooted))).toEqual([
        "nested/note.md",
        "which.txt",
      ]);
    });
  });
});

describe("workflow Git.Add invocation", () => {
  /**
   * A malformed `paths` is refused before anything is staged.
   *
   * The schema refuses most of these on the engine's own terms, which is why the
   * claim here is about the run rather than about which error arrives: nothing
   * ran, and nothing was recorded. `canonicalPaths()` below is what holds the
   * same line for a caller that reaches the Api directly.
   */
  const MALFORMED = [
    { name: "omits paths", written: `<Git.Add />` },
    { name: "writes an empty pathspec", written: `<Git.Add paths="" />` },
    { name: "writes an empty array", written: `<Git.Add paths={[]} />` },
    { name: "writes an empty array member", written: `<Git.Add paths={["a", ""]} />` },
    { name: "writes a member that is not a string", written: `<Git.Add paths={["a", 1]} />` },
    {
      name: "gives it content",
      written: [`<Git.Add paths="which.txt">`, "text", "</Git.Add>"].join("\n"),
    },
  ];

  for (const { name, written } of MALFORMED) {
    it(`refuses an invocation that ${name}`, function* () {
      const root = yield* useStorageRoot();
      const remote = yield* useBareRemote(REMOTE);

      yield* withStorage(root, function* () {
        const database = yield* createRun();
        const counting = countingHost();
        const failure = yield* raised(
          runDocument(database, document(remote.locator, written), countingOptions(counting)),
        );

        expect(failure).not.toBe(undefined);
        expect(subcommands(counting.counters)).not.toContain("add");
        expect(yield* gitEvents(database)).toHaveLength(0);
      });
    });
  }

  it("canonicalizes a string and refuses everything a pathspec is not", function* () {
    expect(canonicalPaths("which.txt")).toEqual(["which.txt"]);
    expect(canonicalPaths(["a", "a"])).toEqual(["a", "a"]);
    for (const malformed of [undefined, "", [], ["a", ""], ["a", 1], 1, true, { a: 1 }]) {
      const refused = yield* raised(
        // deno-lint-ignore require-yield
        (function* () {
          return canonicalPaths(malformed as Json);
        })(),
      );
      expect(causedBy(refused, isGitFailure)?.reason).toBe("invalid-invocation");
    }
  });
});

describe("workflow Git.Add selection", () => {
  it("stages inside the linked Worktree the working directory selects", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runDocument(
        database,
        document(
          remote.locator,
          `<Worktree name="implementation" branch="feature/new" as="worktree" />`,
          "<Dir path={worktree}>",
          `<File path="added.txt">`,
          "fresh",
          "</File>",
          `<Git.Add paths="added.txt" />`,
          "</Dir>",
        ),
      );

      const [worktree] = yield* retainedWorktrees(database, "project");
      expect(yield* stagedPaths(database, String(worktree?.checkoutPath))).toEqual(["added.txt"]);
      // The Repository's own checkout staged nothing.
      expect(yield* stagedPaths(database, yield* checkout(database))).toEqual([]);

      const [outcome] = yield* gitOutcomes(database);
      const identity = Object(Reflect.get(Object(outcome?.record), "checkout"));
      expect(identity.worktreeName).toBe("implementation");
      expect(identity.checkoutPath).toBe(worktree?.checkoutPath);
    });
  });

  it("reads `.` inside a linked Worktree's own subdirectory", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runDocument(
        database,
        document(
          remote.locator,
          `<Worktree name="implementation" branch="feature/new" as="worktree" />`,
          "<Dir path={worktree}>",
          `<File path="which.txt">`,
          "changed",
          "</File>",
          `<File path="nested/note.md">`,
          "revised",
          "</File>",
          `<Dir path="nested">`,
          `<Git.Add paths="." />`,
          "</Dir>",
          "</Dir>",
        ),
      );

      const [worktree] = yield* retainedWorktrees(database, "project");
      expect(yield* stagedPaths(database, String(worktree?.checkoutPath))).toEqual([
        "nested/note.md",
      ]);
    });
  });

  it("fails on a working directory inside no checkout, without staging", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();
      const failure = yield* raised(
        runDocument(
          database,
          document(remote.locator, `<Dir path="/somewhere">`, `<Git.Add paths="." />`, "</Dir>"),
          countingOptions(counting),
        ),
      );

      expect(causedBy(failure, isAuthorityFailure)).toBeInstanceOf(GitOperationAuthorityError);
      expect(causedBy(failure, isGitFailure)).toBe(undefined);
      expect(subcommands(counting.counters)).not.toContain("add");
      expect(yield* gitEvents(database)).toHaveLength(0);
    });
  });

  it("gives a forged Repository context no authority to stage", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    const source = [
      `<Repository name="project" url="${remote.locator}" as="repository" />`,
      "<Dir path={repository}>",
      `<Git.Add paths="which.txt" />`,
      "</Dir>",
    ].join("\n");

    yield* withStorage(root, function* () {
      const unretained = yield* createRun({ runId: "ghost" });
      const counting = countingHost();
      const ghost = yield* raised(runForged(unretained, FORGED, source, countingOptions(counting)));
      expect(causedBy(ghost, isAuthorityFailure)).toBeInstanceOf(GitOperationAuthorityError);
      expect(yield* gitEvents(unretained)).toHaveLength(0);

      // A real name carrying a substituted member is refused for the member.
      const substituted = yield* createRun({ runId: "substituted" });
      const failure = yield* raised(
        runForged(substituted, { ...FORGED, name: "project" }, source, countingOptions(counting)),
      );
      expect(causedBy(failure, isAuthorityFailure)).toBeInstanceOf(GitOperationAuthorityError);
      expect(yield* retainedRepositories(substituted)).toHaveLength(1);
      expect(yield* gitEvents(substituted)).toHaveLength(0);
      expect(subcommands(counting.counters)).not.toContain("add");
    });
  });

  it("fails outside a Repository, past every region", function* () {
    const root = yield* useStorageRoot();

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const printed = yield* raised(
        runDocument(
          database,
          ["<PrintErrors>", `<Git.Add paths="." />`, "", "later", "</PrintErrors>"].join("\n"),
        ),
      );

      expect(causedBy(printed, isAuthorityFailure)).toBeInstanceOf(GitOperationAuthorityError);
      expect(yield* gitEvents(database)).toHaveLength(0);
    });
  });

  it("does not turn a missing provider into a refusal", function* () {
    const failure = yield* raised(
      scoped(function* () {
        yield* useCompositionComponents();
        yield* RepositoryContext.around({ current: () => FORGED }, { at: "min" });
        return yield* collect(
          yield* execute({
            ...inlineSource(`<Git.Add paths="." />`),
            stream: new InMemoryStream(),
          }),
        );
      }),
    );

    expect(causedBy(failure, isProviderError)).toBeInstanceOf(GitCompositionProviderError);
    expect(causedBy(failure, isGitFailure)).toBe(undefined);
  });

  it("is an ordinary default a nested registration shadows", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();
      const output = yield* scoped(function* () {
        return yield* withWorkflowWorkspace(
          database,
          scoped(function* () {
            yield* registerComponents([
              {
                name: "Git.Add",
                origin: "test",
                props: { type: "object", additionalProperties: true },
                // deno-lint-ignore require-yield
                *fn(): Operation<string> {
                  return "shadowed";
                },
              },
            ]);
            return yield* collect(
              yield* execute({
                ...inlineSource(document(remote.locator, `<Git.Add paths="." />`)),
                stream: database.journal,
              }),
            );
          }),
          countingOptions(counting),
        );
      });

      expect(String(output)).toContain("shadowed");
      expect(yield* gitEvents(database)).toHaveLength(0);
      expect(subcommands(counting.counters)).not.toContain("add");
    });
  });
});
