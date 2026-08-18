/**
 * Tier WF — `<Git.Commit>` as a document writes it.
 *
 * What is under test is a commit that survives in the run's own Workspace: the
 * object it wrote, the bytes of its message, the instant it recorded and the
 * value it handed back. The discriminating observation is the commit object
 * itself, read out of the retained checkout with `cat-file` — a retained result
 * says what this provider believes, and only the object says what Git did.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { collect, execute, inlineSource, registerComponents } from "@executablemd/core";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { scoped, sleep } from "effection";
import type { Operation } from "effection";
import { cwd } from "@executablemd/runtime";
import {
  GitCompositionProviderError,
  GitOperationAuthorityError,
  GitOperationError,
  GitOperationInfrastructureError,
} from "../src/composition/errors.ts";
import { currentRepository, RepositoryContext } from "../src/composition/context.ts";
import { GitComposition } from "../src/composition/git-api.ts";
import { parseGitCommitResult } from "../src/composition/git-records.ts";
import type {
  GitCommitExpectation,
  GitCommitMessageSource,
} from "../src/composition/git-records.ts";
import { useCompositionComponents } from "../src/composition/installation.ts";
import {
  admitCommitMessage,
  canonicalCommitMessage,
  composeCommitMessage,
} from "../src/composition/components/GitCommit.ts";
import type { RepositoryRecord } from "../src/composition/records.ts";
import { denoRepositoryHost } from "../src/deno/composition/host.ts";
import type { GitInvocation, GitOutcome } from "../src/deno/composition/host.ts";
import { gitCommitMessageEvidence } from "../src/deno/composition/commit.ts";
import { gitOperationFingerprint } from "../src/deno/composition/operations.ts";
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
  headCommit,
  inCheckout,
  raised,
  retainedRepositories,
  retainedWorktrees,
  runDocument,
  stagedPaths,
  subcommands,
} from "./support/composition.ts";

/** One tracked file at the root and one in a subdirectory. */
const REMOTE = {
  commits: [
    {
      message: "first",
      entries: [
        { path: "which.txt", content: "main\n" },
        { path: "nested/note.md", content: "note\n" },
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

function isInfrastructureFailure(value: unknown): value is GitOperationInfrastructureError {
  return value instanceof GitOperationInfrastructureError;
}

function document(locator: string, ...lines: string[]): string {
  return [`<Repository name="project" url="${locator}">`, ...lines, "</Repository>"].join("\n");
}

/** A document that writes one file, stages it and commits it. */
function staging(locator: string, message: string, ...extra: string[]): string {
  return document(
    locator,
    `<File path="added.txt">`,
    "fresh",
    "</File>",
    `<Git.Commit message={${JSON.stringify(message)}} as="sha">`,
    `<Git.Add paths="added.txt" />`,
    "</Git.Commit>",
    ...extra,
    "",
    "sha: {sha}",
  );
}

/** What a retained result is read back for. */
function* expectation(
  database: WorkflowRunDatabase,
  message: string,
  source: GitCommitMessageSource,
  workingDirectory?: string,
): Operation<GitCommitExpectation> {
  const [repository] = yield* retainedRepositories(database);
  if (repository === undefined) {
    throw new Error("the run retained no repository to read a result against");
  }
  const evidence = gitCommitMessageEvidence(message);
  return {
    repository: repository.record,
    workingDirectory: workingDirectory ?? repository.record.checkoutPath,
    messageSource: source,
    messageDigest: evidence.digest,
    messageLength: evidence.length,
  };
}

/** The primary checkout's Workspace path, once this run has retained one. */
function* checkout(database: WorkflowRunDatabase): Operation<string> {
  const [repository] = yield* retainedRepositories(database);
  if (repository === undefined) {
    throw new Error("the run retained no repository");
  }
  return repository.record.checkoutPath;
}

/** One `<Git.Commit>` under a Repository context the run did not install. */
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

describe("workflow Git.Commit", () => {
  it("commits what its children staged and binds the full SHA", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();
      const message = "add a file\n";
      const output = yield* runDocument(
        database,
        staging(remote.locator, "add a file"),
        countingOptions(counting),
      );

      // The children ran first, as their own effect, and this one committed
      // what they left in the index.
      expect(counting.counters.effects).toEqual(["repository:project", "git:add", "git:commit"]);
      const [added, committed] = yield* gitEvents(database);
      expect(added?.type === "yield" ? added.description.type : "").toBe("workspace_git_add");
      expect(committed?.type === "yield" ? committed.description.type : "").toBe(
        "workspace_git_commit",
      );

      const object = yield* headCommit(database, yield* checkout(database));
      expect(object.message).toBe(message);
      expect(object.parents).toHaveLength(1);
      expect(object.branch).toBe("main");

      // The binding is the object's own id, and nothing was rendered but it.
      expect(String(output)).toContain(`sha: ${object.commit}`);

      const [, outcome] = yield* gitOutcomes(database);
      expect(outcome?.status).toBe("ok");
      const retained = parseGitCommitResult(
        outcome?.record,
        yield* expectation(database, message, "prop"),
      );
      expect(retained?.commit).toBe(object.commit);
      expect(retained?.parent).toBe(object.parents[0]);
      expect(retained?.tree).toBe(object.tree);
      expect(retained?.checkout.repositoryName).toBe("project");
      expect(retained?.checkout.worktreeName).toBe(null);
      expect(retained?.messageSource).toBe("prop");
      expect(retained?.after.commit).toBe(object.commit);
      expect(retained?.after.headTree).toBe(object.tree);
      expect(retained?.after.indexTree).toBe(object.tree);
      expect(retained?.before.commit).toBe(retained?.parent);

      // Nothing is staged afterwards: the index and HEAD describe one tree.
      expect(yield* stagedPaths(database, yield* checkout(database))).toEqual([]);
    });
  });

  it("commits the staged index and leaves unstaged and untracked work alone", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();
      yield* runDocument(
        database,
        document(
          remote.locator,
          `<File path="added.txt">`,
          "fresh",
          "</File>",
          `<Git.Add paths="added.txt" />`,
          // Written after the staging, so one tracked file is modified and one
          // path is untracked when the commit runs.
          `<File path="which.txt">`,
          "changed",
          "</File>",
          `<File path="loose.txt">`,
          "loose",
          "</File>",
          `<Git.Commit message="only the index" as="sha" />`,
        ),
        countingOptions(counting),
      );

      // No implicit staging: exactly one `add`, and the document wrote it.
      expect(subcommands(counting.counters).filter((name) => name === "add")).toHaveLength(1);

      const path = yield* checkout(database);
      const inCommit = yield* inCheckout(database, path, function* (git) {
        return (yield* git(["show", "--pretty=format:", "--name-only", "HEAD"]))
          .split("\n")
          .filter((name) => name !== "");
      });
      expect(inCommit).toEqual(["added.txt"]);

      // The modification and the untracked file are still there, uncommitted.
      const left = yield* inCheckout(database, path, function* (git) {
        return {
          unstaged: (yield* git(["diff", "--name-only", "HEAD"]))
            .split("\n")
            .filter((name) => name !== ""),
          untracked: (yield* git(["ls-files", "--others", "--exclude-standard"]))
            .split("\n")
            .filter((name) => name !== ""),
        };
      });
      expect(left.unstaged).toEqual(["which.txt"]);
      expect(left.untracked).toEqual(["loose.txt"]);
    });
  });

  it("stamps author and committer with the one second the provider captured", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const inner = denoRepositoryHost();
      // A second passes between the instant the provider captured and the
      // instant Git runs, so a commit stamped by the clock and a commit stamped
      // by this operation cannot be the same second.
      const host = {
        *git(invocation: GitInvocation): Operation<GitOutcome> {
          if (invocation.args[0] === "commit") {
            yield* sleep(1_100);
          }
          return yield* inner.git(invocation);
        },
        useDirectory: inner.useDirectory,
      };

      yield* runDocument(database, staging(remote.locator, "timed"), { composition: { host } });
      const after = Math.floor(Date.now() / 1000);

      const [, outcome] = yield* gitOutcomes(database);
      const object = yield* headCommit(database, yield* checkout(database));
      const retained = parseGitCommitResult(
        outcome?.record,
        yield* expectation(database, "timed\n", "prop"),
      );
      const second = retained?.committedAt;
      expect(typeof second).toBe("number");
      expect(object.authorTime).toBe(`${second} +0000`);
      expect(object.committerTime).toBe(`${second} +0000`);
      // The stamp is the captured instant rather than the moment Git ran.
      expect(second).toBeLessThan(after);
    });
  });
});

describe("workflow Git.Commit message", () => {
  it("takes the whole message from its content when there is no prop", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runDocument(
        database,
        document(
          remote.locator,
          `<File path="added.txt">`,
          "fresh",
          "</File>",
          `<Git.Add paths="added.txt" />`,
          `<Git.Commit as="sha">`,
          "written as content",
          "</Git.Commit>",
        ),
      );

      const object = yield* headCommit(database, yield* checkout(database));
      expect(object.message).toBe("written as content\n");

      const [, outcome] = yield* gitOutcomes(database);
      const retained = parseGitCommitResult(
        outcome?.record,
        yield* expectation(database, "written as content\n", "children"),
      );
      expect(retained?.messageSource).toBe("children");
    });
  });

  it("puts the prop first and its content one blank line after it", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runDocument(
        database,
        document(
          remote.locator,
          `<File path="added.txt">`,
          "fresh",
          "</File>",
          `<Git.Commit message="prepare the release" as="sha">`,
          `<Git.Add paths="added.txt" />`,
          "",
          "Generated from validated release metadata.",
          "</Git.Commit>",
        ),
      );

      const object = yield* headCommit(database, yield* checkout(database));
      expect(object.message).toBe(
        "prepare the release\n\nGenerated from validated release metadata.\n",
      );

      const [, outcome] = yield* gitOutcomes(database);
      const retained = parseGitCommitResult(
        outcome?.record,
        yield* expectation(database, object.message, "both"),
      );
      expect(retained?.messageSource).toBe("both");
      expect(retained?.messageLength).toBe(new TextEncoder().encode(object.message).length);
    });
  });

  /**
   * The canonical form, byte for byte, out of the object Git wrote.
   *
   * `--cleanup=verbatim` is what makes this hold. Git's own default cleanup
   * strips whitespace at the end of every line and empty lines at the start,
   * which would commit prose nobody wrote and leave the retained digest
   * describing bytes the repository does not hold.
   */
  it("commits the canonical bytes and nothing Git would have tidied", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const written = "\n\n  keep the indent\ntrailing spaces here   \n\n\nlast line   \t \n\n  ";
    const canonical = "\n\n  keep the indent\ntrailing spaces here   \n\n\nlast line\n";

    expect(canonicalCommitMessage(written)).toBe(canonical);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runDocument(database, staging(remote.locator, written));

      const object = yield* headCommit(database, yield* checkout(database));
      expect(object.message).toBe(canonical);

      const [, outcome] = yield* gitOutcomes(database);
      const evidence = gitCommitMessageEvidence(canonical);
      const retained = parseGitCommitResult(
        outcome?.record,
        yield* expectation(database, canonical, "prop"),
      );
      expect(retained?.messageDigest).toBe(evidence.digest);
      expect(retained?.messageLength).toBe(evidence.length);

      // The message itself is nowhere in what the run retained.
      expect(JSON.stringify(outcome?.record)).not.toContain("keep the indent");
    });
  });

  it("reads CRLF and a bare CR as line feeds", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    expect(canonicalCommitMessage("one\r\ntwo\rthree\r\n")).toBe("one\ntwo\nthree\n");

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runDocument(database, staging(remote.locator, "one\r\ntwo\rthree\r\n"));

      const object = yield* headCommit(database, yield* checkout(database));
      expect(object.message).toBe("one\ntwo\nthree\n");
    });
  });

  it("composes and canonicalizes the same way wherever a message enters", function* () {
    expect(composeCommitMessage("only a prop", "")).toEqual({
      message: "only a prop\n",
      source: "prop",
    });
    // Content that renders nothing says nothing: a staging child is not a half
    // of a combined message.
    expect(composeCommitMessage("only a prop", "\n\n")).toEqual({
      message: "only a prop\n",
      source: "prop",
    });
    expect(composeCommitMessage(undefined, "only content\n")).toEqual({
      message: "only content\n",
      source: "children",
    });
    expect(composeCommitMessage("subject", "body\n")).toEqual({
      message: "subject\n\nbody\n",
      source: "both",
    });

    for (const malformed of ["", "   \n", undefined]) {
      const refused = yield* raised(
        // deno-lint-ignore require-yield
        (function* () {
          return composeCommitMessage(malformed, "  \n\n");
        })(),
      );
      expect(causedBy(refused, isGitFailure)?.reason).toBe("invalid-invocation");
    }

    // The Api is held to the boundary the component is held to.
    for (const malformed of ["\n", "no final newline", "trailing  \n", "a\r\nb\n", "\ud800\n"]) {
      const refused = yield* raised(
        // deno-lint-ignore require-yield
        (function* () {
          return admitCommitMessage(malformed);
        })(),
      );
      expect(causedBy(refused, isGitFailure)?.reason).toBe("invalid-invocation");
    }
    expect(admitCommitMessage("� is ordinary text\n")).toBe("� is ordinary text\n");
  });

  it("refuses an unpaired surrogate before an effect or Git exists", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();
      const failure = yield* raised(
        runDocument(
          database,
          staging(remote.locator, "half \ud800 written"),
          countingOptions(counting),
        ),
      );

      expect(causedBy(failure, isGitFailure)?.reason).toBe("invalid-invocation");
      expect(subcommands(counting.counters)).not.toContain("commit");
      // The staging child still ran, because it is its own element; the commit
      // never became an effect.
      expect(
        (yield* gitEvents(database)).map((event) =>
          event.type === "yield" ? event.description.type : "",
        ),
      ).toEqual(["workspace_git_add"]);
    });
  });

  it("commits a message a replacement character is ordinary text in", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runDocument(database, staging(remote.locator, "� is a character"));

      const object = yield* headCommit(database, yield* checkout(database));
      expect(object.message).toBe("� is a character\n");
    });
  });

  const MALFORMED: { name: string; written: string[] }[] = [
    { name: "names no message at all", written: [`<Git.Commit as="sha" />`] },
    {
      name: "renders no text in its content",
      written: [`<Git.Commit as="sha">`, `<Git.Add paths="added.txt" />`, "</Git.Commit>"],
    },
    {
      name: "writes a message that is only whitespace",
      written: [`<Git.Commit message="   " as="sha" />`],
    },
    { name: "is written without as", written: [`<Git.Commit message="no binding" />`] },
  ];

  for (const { name, written } of MALFORMED) {
    it(`refuses an invocation that ${name}`, function* () {
      const root = yield* useStorageRoot();
      const remote = yield* useBareRemote(REMOTE);

      yield* withStorage(root, function* () {
        const database = yield* createRun();
        const counting = countingHost();
        const failure = yield* raised(
          runDocument(
            database,
            document(
              remote.locator,
              `<File path="added.txt">`,
              "fresh",
              "</File>",
              `<Git.Add paths="added.txt" />`,
              ...written,
            ),
            countingOptions(counting),
          ),
        );

        expect(failure).not.toBe(undefined);
        expect(subcommands(counting.counters)).not.toContain("commit");
        expect(counting.counters.effects).not.toContain("git:commit");
      });
    });
  }
});

describe("workflow Git.Commit selection", () => {
  it("commits in the linked Worktree the working directory selects", function* () {
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
          `<Git.Commit message="inside the worktree" as="sha">`,
          `<Git.Add paths="added.txt" />`,
          "</Git.Commit>",
          "</Dir>",
        ),
      );

      const [worktree] = yield* retainedWorktrees(database, "project");
      if (worktree === undefined) {
        throw new Error("the run retained no worktree");
      }
      const object = yield* headCommit(database, worktree.checkoutPath);
      expect(object.branch).toBe("feature/new");
      expect(object.message).toBe("inside the worktree\n");

      const [, outcome] = yield* gitOutcomes(database);
      const retained = parseGitCommitResult(
        outcome?.record,
        yield* expectation(database, "inside the worktree\n", "prop", worktree.checkoutPath),
      );
      expect(retained?.checkout.worktreeName).toBe("implementation");
      expect(retained?.checkout.checkoutPath).toBe(worktree.checkoutPath);
      expect(retained?.commit).toBe(object.commit);

      // The primary checkout did not move.
      const primary = yield* headCommit(database, yield* checkout(database));
      expect(primary.branch).toBe("main");
      expect(primary.commit).not.toBe(object.commit);
    });
  });

  it("commits the whole checkout a nested directory belongs to", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runDocument(
        database,
        document(
          remote.locator,
          `<File path="added.txt">`,
          "fresh",
          "</File>",
          `<Git.Add paths="added.txt" />`,
          `<Dir path="nested">`,
          `<Git.Commit message="written inside nested" as="sha" />`,
          "</Dir>",
        ),
      );

      // Written in `nested/`, and what it committed is the checkout's index —
      // including a path above the directory the element was written in.
      const path = yield* checkout(database);
      const inCommit = yield* inCheckout(database, path, function* (git) {
        return (yield* git(["show", "--pretty=format:", "--name-only", "HEAD"]))
          .split("\n")
          .filter((name) => name !== "");
      });
      expect(inCommit).toEqual(["added.txt"]);

      const [, outcome] = yield* gitOutcomes(database);
      const retained = parseGitCommitResult(
        outcome?.record,
        yield* expectation(database, "written inside nested\n", "prop", `${path}/nested`),
      );
      expect(retained?.checkout.checkoutPath).toBe(path);
    });
  });

  it("fails on a working directory inside no checkout, without committing", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();
      const failure = yield* raised(
        runDocument(
          database,
          [
            `<Repository name="project" url="${remote.locator}" as="repository" />`,
            `<Git.Commit message="nowhere" as="sha" />`,
          ].join("\n"),
          countingOptions(counting),
        ),
      );

      expect(causedBy(failure, isAuthorityFailure)).toBeInstanceOf(GitOperationAuthorityError);
      expect(subcommands(counting.counters)).not.toContain("commit");
      expect(yield* gitEvents(database)).toHaveLength(0);
    });
  });

  it("gives a forged Repository context no authority to commit", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    const source = [
      `<Repository name="project" url="${remote.locator}" as="repository" />`,
      "<Dir path={repository}>",
      `<Git.Commit message="forged" as="sha" />`,
      "</Dir>",
    ].join("\n");

    yield* withStorage(root, function* () {
      const unretained = yield* createRun({ runId: "ghost" });
      const counting = countingHost();
      const ghost = yield* raised(runForged(unretained, FORGED, source, countingOptions(counting)));
      expect(causedBy(ghost, isAuthorityFailure)).toBeInstanceOf(GitOperationAuthorityError);
      expect(causedBy(ghost, isGitFailure)).toBe(undefined);
      expect(yield* gitEvents(unretained)).toHaveLength(0);

      // A real name carrying a substituted member is refused for the member.
      const substituted = yield* createRun({ runId: "substituted" });
      const failure = yield* raised(
        runForged(substituted, { ...FORGED, name: "project" }, source, countingOptions(counting)),
      );
      expect(causedBy(failure, isAuthorityFailure)).toBeInstanceOf(GitOperationAuthorityError);
      expect(yield* retainedRepositories(substituted)).toHaveLength(1);
      expect(yield* gitEvents(substituted)).toHaveLength(0);
      expect(subcommands(counting.counters)).not.toContain("commit");
    });
  });

  it("fails outside a Repository rather than choosing one", function* () {
    const root = yield* useStorageRoot();

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const failure = yield* raised(
        runDocument(database, `<Git.Commit message="nowhere" as="sha" />`),
      );

      expect(causedBy(failure, isAuthorityFailure)).toBeInstanceOf(GitOperationAuthorityError);
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
            ...inlineSource(`<Git.Commit message="nowhere" as="sha" />`),
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
                name: "Git.Commit",
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
                ...inlineSource(
                  document(
                    remote.locator,
                    `<Git.Commit message="ignored" as="sha" />`,
                    "",
                    "sha: {sha}",
                  ),
                ),
                stream: database.journal,
              }),
            );
          }),
          countingOptions(counting),
        );
      });

      // The shadow declares no `returns`, so what it produced binds by
      // reference and the document reads it back.
      expect(String(output)).toContain("sha: shadowed");
      expect(yield* gitEvents(database)).toHaveLength(0);
      expect(subcommands(counting.counters)).not.toContain("commit");
    });
  });
});

describe("workflow Git.Commit transition", () => {
  it("refuses an index that holds nothing HEAD does not", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();
      const failure = yield* raised(
        runDocument(
          database,
          document(remote.locator, `<Git.Commit message="nothing staged" as="sha" />`),
          countingOptions(counting),
        ),
      );

      expect(causedBy(failure, isGitFailure)?.reason).toBe("empty-index");
      // Decided from the checkout's own state: no command ran and no object
      // was written for a commit that was never going to exist.
      expect(subcommands(counting.counters)).not.toContain("commit");

      const object = yield* headCommit(database, yield* checkout(database));
      expect(object.message).toBe("first\n");
    });
  });

  it("fails the run rather than committing when the object is not the one asked for", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const inner = denoRepositoryHost();
      // A commit whose message Git tidied is a commit this operation did not
      // make, whatever its exit status said.
      const host = {
        *git(invocation: GitInvocation): Operation<GitOutcome> {
          if (invocation.args[0] === "commit") {
            return yield* inner.git({
              ...invocation,
              args: invocation.args.filter((argument) => argument !== "--cleanup=verbatim"),
            });
          }
          return yield* inner.git(invocation);
        },
        useDirectory: inner.useDirectory,
      };

      const failure = yield* raised(
        runDocument(database, staging(remote.locator, "tidied   \n\ncontent\n"), {
          composition: { host },
        }),
      );

      expect(causedBy(failure, isInfrastructureFailure)).toBeInstanceOf(
        GitOperationInfrastructureError,
      );
      // Nothing was published for it, and the checkout is where the staging
      // left it.
      expect(
        (yield* gitEvents(database)).map((event) =>
          event.type === "yield" ? event.description.type : "",
        ),
      ).toEqual(["workspace_git_add"]);
      const object = yield* headCommit(database, yield* checkout(database));
      expect(object.message).toBe("first\n");
      expect(yield* stagedPaths(database, yield* checkout(database))).toEqual(["added.txt"]);
    });
  });

  it("identifies one commit by its message rather than by its place alone", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runDocument(database, staging(remote.locator, "identified"));

      const [repository] = yield* retainedRepositories(database);
      const record = repository?.record;
      if (record === undefined) {
        throw new Error("the run retained no repository");
      }
      const [, event] = yield* gitEvents(database);
      expect(event?.type === "yield" ? event.description.configuration : undefined).toBe(
        gitOperationFingerprint([
          record.name,
          record.locatorFingerprint,
          record.requestedBase,
          record.creationCommit,
          record.primaryBranch,
          record.objectFormat,
          record.checkoutPath,
          record.checkoutPath,
          "prop",
          "identified\n",
        ]),
      );
    });
  });
});

/**
 * Admission takes a snapshot, and the snapshot is what runs.
 *
 * A caller's request is the caller's object, and this operation suspends several
 * times between naming itself and spawning Git. The mutation lands when the
 * effect acquires its materialization directory — inside the transaction, after
 * the durable identity exists and before any Git command is given.
 */
describe("workflow Git.Commit request ownership", () => {
  it("commits the message it admitted, not what the caller changed it to", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    let caller: { repository: { name: string }; message: string } | undefined;
    let armed = false;
    let synchronized = false;

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const inner = denoRepositoryHost();
      const counting = countingHost({
        git: (invocation: GitInvocation): Operation<GitOutcome> => inner.git(invocation),
        *useDirectory(): Operation<string> {
          const directory = yield* inner.useDirectory();
          if (armed && !synchronized) {
            synchronized = true;
            const request = caller;
            if (request === undefined) {
              throw new Error("a directory was acquired before the probe asked for anything");
            }
            request.message = "replaced by the caller\n";
            request.repository.name = "ghost";
          }
          return directory;
        },
      });

      yield* scoped(function* () {
        return yield* withWorkflowWorkspace(
          database,
          scoped(function* () {
            yield* registerComponents([
              {
                name: "Probe",
                origin: "test",
                props: { type: "object", additionalProperties: false },
                *fn(): Operation<string> {
                  const repository = yield* currentRepository();
                  if (repository === undefined) {
                    throw new Error("the probe was written outside a Repository");
                  }
                  const request = {
                    repository: { ...repository },
                    workingDirectory: yield* cwd(),
                    message: "admitted by the operation\n",
                    messageSource: "prop" as const,
                  };
                  caller = request;
                  armed = true;
                  yield* GitComposition.operations.commitIndex(request);
                  return "";
                },
              },
            ]);
            return yield* collect(
              yield* execute({
                ...inlineSource(
                  document(
                    remote.locator,
                    `<File path="added.txt">`,
                    "fresh",
                    "</File>",
                    `<Git.Add paths="added.txt" />`,
                    "<Probe />",
                  ),
                ),
                stream: database.journal,
              }),
            );
          }),
          countingOptions(counting),
        );
      });

      // The premise: the caller's request really changed, at a point the
      // operation really reached.
      expect(synchronized).toBe(true);
      expect(caller?.message).toBe("replaced by the caller\n");
      expect(caller?.repository.name).toBe("ghost");

      // What Git committed is what admission returned.
      const object = yield* headCommit(database, yield* checkout(database));
      expect(object.message).toBe("admitted by the operation\n");

      const [, outcome] = yield* gitOutcomes(database);
      expect(outcome?.status).toBe("ok");
      const retained = parseGitCommitResult(
        outcome?.record,
        yield* expectation(database, "admitted by the operation\n", "prop"),
      );
      expect(retained?.commit).toBe(object.commit);
      expect(retained?.checkout.repositoryName).toBe("project");
    });
  });
});
