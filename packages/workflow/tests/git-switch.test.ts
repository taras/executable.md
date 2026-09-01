/**
 * Tier WF — `<Git.Switch>` as a document writes it.
 *
 * These drive the real component through `execute()` against a real run
 * database, a real local remote and a real `git`, because what is under test is
 * a branch change that survives in the run's own Workspace: which checkout it
 * lands in, what it refuses, and what it retains about both.
 *
 * The discriminating observations are the Git subcommands a run issued, the
 * journal event the effect appended and its status, and what the Workspace holds
 * afterwards. Rendered text alone proves none of them — a switch renders
 * nothing.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { registerComponents } from "@executablemd/core";
import type { ComponentRegistration } from "@executablemd/core";
import { collect, execute, inlineSource } from "@executablemd/core";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { scoped, until } from "effection";
import { readTextFile, writeTextFile } from "@effectionx/fs";
import { pathToFileURL } from "node:url";
import { cwd } from "@executablemd/runtime";
import type { Operation } from "effection";
import {
  GitCompositionProviderError,
  GitOperationAuthorityError,
  GitOperationError,
  GitOperationInfrastructureError,
} from "../src/composition/errors.ts";
import { currentRepository, RepositoryContext } from "../src/composition/context.ts";
import { GitComposition } from "../src/composition/git-api.ts";
import { parseGitSwitchResult } from "../src/composition/git-records.ts";
import type { GitSwitchExpectation } from "../src/composition/git-records.ts";
import { useCompositionComponents } from "../src/composition/installation.ts";
import { denoRepositoryHost } from "../src/deno/composition/host.ts";
import type { GitInvocation, GitOutcome } from "../src/deno/composition/host.ts";
import { gitOperationFingerprint } from "../src/deno/composition/operations.ts";
import { withWorkflowWorkspace } from "../src/deno/workspace/host.ts";
import type { WorkflowWorkspaceOptions } from "../src/deno/workspace/host.ts";
import type { RepositoryRecord } from "../src/composition/records.ts";
import type { WorkflowRunDatabase } from "../src/storage/api.ts";
import type { DenoWorkspaceFilesystem } from "../src/deno/workspace/filesystem.ts";
import { throwWorkspaceFilesystemFailure } from "../src/deno/workspace/errors.ts";
import { createRun, runPath, useStorageRoot, withStorage } from "./support/storage.ts";
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
  retainedWorktrees,
  runDocument,
  subcommands,
  survivingRoots,
  workspaceText,
} from "./support/composition.ts";
import type { LoadedGitApi } from "./support/composition.ts";
import { committedRoot, dropRootClose, latestRoot, publishedRoots } from "./support/replay.ts";

import {
  filteredRepositoryIdentity,
  type RepositorySelection,
} from "../src/composition/selection.ts";
/**
 * Two branches whose content differs, plus one file that does not.
 *
 * `which.txt` is what says which branch a checkout is on; `shared.txt` is
 * identical on both, which is what makes a carried local change different from a
 * change Git would overwrite.
 */
const REMOTE = {
  commits: [
    {
      message: "first",
      entries: [
        { path: "which.txt", content: "main\n" },
        { path: "shared.txt", content: "shared\n" },
        { path: "nested/note.md", content: "note\n" },
      ],
    },
    {
      message: "release",
      branch: "release",
      entries: [{ path: "which.txt", content: "release\n" }],
    },
  ],
} as const;

/** Text a suite looks for to say whether work after a failure still ran. */
const LATER = "later sibling ran";

function isGitFailure(value: unknown): value is GitOperationError {
  return value instanceof GitOperationError;
}

function isProviderError(value: unknown): value is GitCompositionProviderError {
  return value instanceof GitCompositionProviderError;
}

function isAuthorityFailure(value: unknown): value is GitOperationAuthorityError {
  return value instanceof GitOperationAuthorityError;
}

function isInfrastructureFailure(value: unknown): value is GitOperationInfrastructureError {
  return value instanceof GitOperationInfrastructureError;
}

/** A well-formed record naming a Repository nothing retains. */
const FORGED: RepositorySelection = Object.freeze({
  selection: "forged",
  name: "ghost",
  identity: Object.freeze({
    name: "ghost",
    locatorFingerprint: "0".repeat(64),
    requestedBase: null,
    creationCommit: "0".repeat(40),
    primaryBranch: "main",
    objectFormat: "sha1" as const,
  }),
  checkoutPath: "/repositories/ghost",
});

/**
 * One `<Git.Switch>` under a Repository context the run did not install.
 *
 * The context is the only thing a document could replace, so this is what a
 * replaced one buys: the component reads it, the provider reads the run, and the
 * two have to agree about a checkout that is really there.
 */
function runForged(
  database: WorkflowRunDatabase,
  record: RepositorySelection,
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

/**
 * What a retained result is read back for.
 *
 * A result is parsed for one request, so a suite that wants to read one has to
 * say which request it is reading it for — which is the point: the parse is a
 * comparison, and a suite that could skip the comparison would be asserting
 * something weaker than the run does.
 */
function* expectation(
  database: WorkflowRunDatabase,
  branch: string,
  base?: string,
  within = "",
): Operation<GitSwitchExpectation> {
  const [repository] = yield* retainedRepositories(database);
  if (repository === undefined) {
    throw new Error("the run retained no repository to read a result against");
  }
  const [worktree] = yield* retainedWorktrees(database, repository.record.name);
  return {
    repository: repository.record,
    workingDirectory:
      within === "" || worktree === undefined
        ? `${repository.record.checkoutPath}${within}`
        : worktree.checkoutPath,
    branch,
    base,
  };
}
function document(locator: string, ...lines: string[]): string {
  return [`<Repository name="project" url="${locator}">`, ...lines, "</Repository>"].join("\n");
}

describe("workflow Git.Switch", () => {
  it("moves the primary checkout to a branch the remote published", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();
      const output = yield* runDocument(
        database,
        document(
          remote.locator,
          `<Git.Switch branch="release" />`,
          `<File path="which.txt" as="which" />`,
          "",
          "after: {which}",
        ),
        countingOptions(counting),
      );

      expect(String(output)).toContain("after: release");
      expect(subcommands(counting.counters)).toContain("switch");
      expect(counting.counters.effects).toEqual(["repository:project", "git:switch"]);

      const [outcome] = yield* gitOutcomes(database);
      expect(outcome?.status).toBe("ok");
      const retained = parseGitSwitchResult(
        outcome?.record,
        yield* expectation(database, "release"),
      );
      expect(retained?.checkout.repositoryName).toBe("project");
      expect(retained?.checkout.worktreeName).toBe(null);
      expect(retained?.requestedBranch).toBe("release");
      expect(retained?.resolvedBranch).toBe("release");
      expect(retained?.requestedBase).toBe(null);
      // The branch already existed, so nothing was created from a base.
      expect(retained?.resolvedBase).toBe(null);
      expect(retained?.before.branch).toBe("main");
      expect(retained?.before.commit).toBe(remote.heads.get("main"));
      expect(retained?.after.commit).toBe(remote.heads.get("release"));
      expect(retained?.before.headTree).not.toBe(retained?.after.headTree);
      // A clean checkout stages nothing, so the index describes what HEAD does.
      expect(retained?.after.indexTree).toBe(retained?.after.headTree);
      expect(yield* survivingRoots(counting.counters)).toEqual([]);
    });
  });

  it("creates a missing branch where the checkout already is", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const output = yield* runDocument(
        database,
        document(
          remote.locator,
          `<Git.Switch branch="feature/new" />`,
          `<File path="which.txt" as="which" />`,
          "",
          "after: {which}",
        ),
      );

      expect(String(output)).toContain("after: main");
      const [outcome] = yield* gitOutcomes(database);
      const retained = parseGitSwitchResult(
        outcome?.record,
        yield* expectation(database, "feature/new"),
      );
      expect(retained?.resolvedBranch).toBe("feature/new");
      expect(retained?.requestedBase).toBe(null);
      expect(retained?.resolvedBase).toBe(remote.heads.get("main"));
      expect(retained?.after.commit).toBe(remote.heads.get("main"));
    });
  });

  it("creates a missing branch from the supplied base", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const output = yield* runDocument(
        database,
        document(
          remote.locator,
          `<Git.Switch branch="feature/new" base="release" />`,
          `<File path="which.txt" as="which" />`,
          "",
          "after: {which}",
        ),
      );

      expect(String(output)).toContain("after: release");
      const [outcome] = yield* gitOutcomes(database);
      const retained = parseGitSwitchResult(
        outcome?.record,
        yield* expectation(database, "feature/new", "release"),
      );
      expect(retained?.requestedBase).toBe("release");
      expect(retained?.resolvedBase).toBe(remote.heads.get("release"));
      expect(retained?.after.commit).toBe(remote.heads.get("release"));
    });
  });

  it("moves the linked worktree the working directory selects", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const output = yield* runDocument(
        database,
        document(
          remote.locator,
          `<Worktree name="implementation" branch="feature/new" as="worktree" />`,
          "<Dir path={worktree}>",
          `<Git.Switch branch="release" />`,
          `<File path="which.txt" as="inside" />`,
          "",
          "inside: {inside}",
          "</Dir>",
          `<File path="which.txt" as="outside" />`,
          "",
          "outside: {outside}",
        ),
      );

      const rendered = String(output);
      expect(rendered).toContain("inside: release");
      // The primary checkout did not move: the working directory selected the
      // worktree, and a Git operation moves exactly the checkout it ran in.
      expect(rendered).toContain("outside: main");

      const [outcome] = yield* gitOutcomes(database);
      const retained = parseGitSwitchResult(
        outcome?.record,
        yield* expectation(database, "release", undefined, "/worktrees/"),
      );
      expect(retained?.checkout.worktreeName).toBe("implementation");
      expect(retained?.before.branch).toBe("feature/new");
      expect(retained?.after.branch).toBe("release");
    });
  });

  it("carries a change the branches agree about", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const output = yield* runDocument(
        database,
        document(
          remote.locator,
          `<File path="shared.txt">`,
          "carried",
          "</File>",
          `<Git.Switch branch="release" />`,
          `<File path="which.txt" as="which" />`,
          `<File path="shared.txt" as="shared" />`,
          "",
          "which: {which}",
          "shared: {shared}",
        ),
      );

      const rendered = String(output);
      expect(rendered).toContain("which: release");
      const [repository] = yield* retainedRepositories(database);
      expect(
        yield* workspaceText(database, `${repository?.record.checkoutPath}/shared.txt`),
      ).toContain("carried");
      const [outcome] = yield* gitOutcomes(database);
      const retained = parseGitSwitchResult(
        outcome?.record,
        yield* expectation(database, "release"),
      );
      // A modified working tree is not a staged one: the index still describes
      // HEAD on both sides of the switch.
      expect(retained?.before.indexTree).toBe(retained?.before.headTree);
      expect(retained?.after.indexTree).toBe(retained?.after.headTree);
    });
  });

  it("refuses a change the branch would overwrite, and moves nothing", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, "release-1.4");

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();
      const failure = yield* raised(
        runDocument(
          database,
          document(
            remote.locator,
            `<File path="which.txt">`,
            "local",
            "</File>",
            `<Git.Switch branch="release" />`,
          ),
          countingOptions(counting),
        ),
      );

      const refusal = causedBy(failure, isGitFailure);
      expect(refusal?.reason).toBe("overwrites-local-changes");
      expect(refusal?.operation).toBe("<Git.Switch>");
      expect(String(refusal)).toContain("Nothing was discarded");

      // The refusal is the effect's failed outcome, published against a
      // Workspace root that did not move: the file write before it published
      // one, and that is still the run's latest.
      const [outcome] = yield* gitOutcomes(database);
      expect(outcome?.status).toBe("err");
      expect(committedRoot(path)).toBe(latestRoot(path));
      const [repository] = yield* retainedRepositories(database);
      const held = yield* workspaceText(database, `${repository?.record.checkoutPath}/which.txt`);
      expect(held).toContain("local");
      expect(held).not.toContain("release");
      expect(subcommands(counting.counters)).toContain("switch");
    });
  });

  it("refuses a branch another checkout of the same repository holds", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const failure = yield* raised(
        runDocument(
          database,
          document(
            remote.locator,
            `<Worktree name="implementation" branch="release" as="worktree" />`,
            `<Git.Switch branch="release" />`,
          ),
        ),
      );

      const refusal = causedBy(failure, isGitFailure);
      expect(refusal?.reason).toBe("branch-checked-out-elsewhere");
      expect(String(refusal)).toContain("Nothing was moved");
      const [outcome] = yield* gitOutcomes(database);
      expect(outcome?.status).toBe("err");
    });
  });
});

describe("workflow Git.Switch selection", () => {
  it("selects the enclosing checkout from a directory inside it", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const output = yield* runDocument(
        database,
        document(
          remote.locator,
          `<Dir path="nested">`,
          `<Git.Switch branch="release" />`,
          "</Dir>",
          `<File path="which.txt" as="which" />`,
          "",
          "after: {which}",
        ),
      );

      // A directory inside a checkout is where Git runs, not what it runs on:
      // the whole checkout moved, and the retained identity is the Repository's.
      expect(String(output)).toContain("after: release");
      const [outcome] = yield* gitOutcomes(database);
      const [repository] = yield* retainedRepositories(database);
      const retained = parseGitSwitchResult(
        outcome?.record,
        yield* expectation(database, "release", undefined, "/nested"),
      );
      expect(retained?.checkout.worktreeName).toBe(null);
      expect(retained?.checkout.checkoutPath).toBe(repository?.record.checkoutPath);
      expect(retained?.after.branch).toBe("release");
    });
  });

  it("selects a linked Worktree from a directory inside it", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const output = yield* runDocument(
        database,
        document(
          remote.locator,
          `<Worktree name="implementation" branch="feature/new" as="worktree" />`,
          "<Dir path={worktree}>",
          `<Dir path="nested">`,
          `<Git.Switch branch="release" />`,
          "</Dir>",
          `<File path="which.txt" as="inside" />`,
          "",
          "inside: {inside}",
          "</Dir>",
          `<File path="which.txt" as="outside" />`,
          "",
          "outside: {outside}",
        ),
      );

      const rendered = String(output);
      expect(rendered).toContain("inside: release");
      expect(rendered).toContain("outside: main");
      const [outcome] = yield* gitOutcomes(database);
      const [worktree] = yield* retainedWorktrees(database, "project");
      const retained = parseGitSwitchResult(
        outcome?.record,
        yield* expectation(database, "release", undefined, "/worktrees/"),
      );
      expect(retained?.checkout.worktreeName).toBe("implementation");
      expect(retained?.checkout.checkoutPath).toBe(worktree?.checkoutPath);
    });
  });

  it("fails on a working directory inside no checkout, without running Git", function* () {
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
            `<Dir path="/somewhere">`,
            `<Git.Switch branch="release" />`,
            "</Dir>",
          ),
          countingOptions(counting),
        ),
      );

      // Nobody asked for a checkout that is not there, so nothing was published
      // to say an operation happened.
      expect(causedBy(failure, isAuthorityFailure)).toBeInstanceOf(GitOperationAuthorityError);
      expect(causedBy(failure, isGitFailure)).toBe(undefined);
      expect(yield* gitEvents(database)).toHaveLength(0);
      expect(subcommands(counting.counters)).not.toContain("switch");
    });
  });

  it("fails on a working directory that is not a real directory in the checkout", function* () {
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
            `<Dir path="absent">`,
            `<Git.Switch branch="release" />`,
            "</Dir>",
          ),
          countingOptions(counting),
        ),
      );

      expect(causedBy(failure, isAuthorityFailure)).toBeInstanceOf(GitOperationAuthorityError);
      expect(yield* gitEvents(database)).toHaveLength(0);
      expect(subcommands(counting.counters)).not.toContain("switch");
    });
  });

  it("gives a forged Repository context no authority over anything", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    // A self-closing `<Repository>` retains a checkout without installing a
    // context, so the only context these documents have is the forged one.
    const source = [
      `<Repository name="project" url="${remote.locator}" as="repository" />`,
      `<Git.Switch branch="release" />`,
    ].join("\n");

    yield* withStorage(root, function* () {
      const unretainedRun = yield* createRun({ runId: "ghost" });
      const counting = countingHost();
      const unretained = yield* raised(
        runForged(unretainedRun, FORGED, source, countingOptions(counting)),
      );
      expect(causedBy(unretained, isAuthorityFailure)).toBeInstanceOf(GitOperationAuthorityError);
      expect(causedBy(unretained, isGitFailure)).toBe(undefined);
      // Not an outcome: nothing about it is in this run's history.
      expect(yield* gitEvents(unretainedRun)).toHaveLength(0);

      // The second context names a Repository this run really retains, and
      // carries a record that is not the retained one. A name can be looked up;
      // the record is compared, so the substitution is what fails.
      const substitutedRun = yield* createRun({ runId: "substituted" });
      const substituted = yield* raised(
        runForged(
          substitutedRun,
          { ...FORGED, name: "project" },
          source,
          countingOptions(counting),
        ),
      );
      expect(causedBy(substituted, isAuthorityFailure)).toBeInstanceOf(GitOperationAuthorityError);
      expect(yield* retainedRepositories(substitutedRun)).toHaveLength(1);
      expect(yield* gitEvents(substitutedRun)).toHaveLength(0);

      // And a context carrying the retained Repository's own facts, exactly,
      // still supplies no authority: a selection is what this provider minted,
      // not what a value says about itself. The identity here is the one the
      // first run retained, which the same fixture retains again here —
      // creation identity is a function of the name, the url and the base.
      const [retained] = yield* retainedRepositories(unretainedRun);
      const exactRun = yield* createRun({ runId: "exact" });
      const exact = yield* raised(
        runForged(
          exactRun,
          retained === undefined
            ? FORGED
            : {
                ...FORGED,
                name: retained.record.name,
                identity: filteredRepositoryIdentity(retained.record),
                checkoutPath: retained.record.checkoutPath,
              },
          source,
          countingOptions(counting),
        ),
      );
      expect(causedBy(exact, isAuthorityFailure)).toBeInstanceOf(GitOperationAuthorityError);
      expect(subcommands(counting.counters)).not.toContain("switch");
    });
  });

  it("fails outside a Repository rather than choosing one, past every region", function* () {
    const root = yield* useStorageRoot();

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const failure = yield* raised(runDocument(database, `<Git.Switch branch="release" />`));

      // No repository in scope is missing authority, not an outcome a document
      // asked for and did not get.
      expect(causedBy(failure, isAuthorityFailure)).toBeInstanceOf(GitOperationAuthorityError);
      expect(causedBy(failure, isGitFailure)).toBe(undefined);
      expect(yield* gitEvents(database)).toHaveLength(0);

      // And an authored region cannot decide otherwise: a printed one would let
      // the siblings after it run as though a branch had moved.
      const printing = yield* createRun({ runId: "printing" });
      const printed = yield* raised(
        runDocument(
          printing,
          ["<PrintErrors>", `<Git.Switch branch="release" />`, "", LATER, "</PrintErrors>"].join(
            "\n",
          ),
        ),
      );
      expect(causedBy(printed, isAuthorityFailure)).toBeInstanceOf(GitOperationAuthorityError);
      expect(yield* gitEvents(printing)).toHaveLength(0);
    });
  });

  it("does not turn a missing provider into a refusal", function* () {
    const failure = yield* raised(
      scoped(function* () {
        yield* useCompositionComponents();
        yield* RepositoryContext.around({ current: () => FORGED }, { at: "min" });
        return yield* collect(
          yield* execute({
            ...inlineSource(`<Git.Switch branch="release" />`),
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
                name: "Git.Switch",
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
                ...inlineSource(document(remote.locator, `<Git.Switch branch="release" />`)),
                stream: database.journal,
              }),
            );
          }),
          countingOptions(counting),
        );
      });

      expect(String(output)).toContain("shadowed");
      expect(yield* gitEvents(database)).toHaveLength(0);
      expect(subcommands(counting.counters)).not.toContain("switch");
    });
  });
});

describe("workflow Git.Switch failure kinds", () => {
  it("does not turn an unexpected host failure into a refusal", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const inner = denoRepositoryHost();
      const broken = {
        *git(invocation: GitInvocation): Operation<GitOutcome> {
          if (invocation.args[0] === "switch") {
            throw new Error("the host could not run git");
          }
          return yield* inner.git(invocation);
        },
        useDirectory: inner.useDirectory,
      };

      const failure = yield* raised(
        runDocument(
          database,
          [
            "<PrintErrors>",
            document(remote.locator, `<Git.Switch branch="release" />`),
            "",
            "later",
            "</PrintErrors>",
          ].join("\n"),
          { composition: { host: broken } },
        ),
      );

      // Even under an authored region: a host that cannot run Git is not
      // something the document asked for, so it was never offered as one.
      expect(failure).not.toBe(undefined);
      expect(causedBy(failure, isGitFailure)).toBe(undefined);
      expect(yield* gitEvents(database)).toHaveLength(0);
    });
  });

  it("does not turn a Git failure it has no word for into a refusal", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const inner = denoRepositoryHost();
      const unfamiliar = {
        *git(invocation: GitInvocation): Operation<GitOutcome> {
          if (invocation.args[0] === "switch") {
            // Sanitized, and unlike anything this provider recognizes: the
            // question is what happens to an exit it has no word for.
            return { code: 1, stdout: "", stderr: "fatal: a condition from a later Git\n" };
          }
          return yield* inner.git(invocation);
        },
        useDirectory: inner.useDirectory,
      };

      const failure = yield* raised(
        runDocument(
          database,
          [
            "<PrintErrors>",
            document(remote.locator, `<Git.Switch branch="release" />`),
            "",
            "later",
            "</PrintErrors>",
          ].join("\n"),
          { composition: { host: unfamiliar } },
        ),
      );

      // Naming it the nearest refusal would publish a durable result claiming
      // this run knows what happened, so it fails the run and retains nothing.
      expect(causedBy(failure, isInfrastructureFailure)).toBeInstanceOf(
        GitOperationInfrastructureError,
      );
      expect(causedBy(failure, isGitFailure)).toBe(undefined);
      expect(yield* gitEvents(database)).toHaveLength(0);
      const [repository] = yield* retainedRepositories(database);
      expect(yield* workspaceText(database, `${repository?.record.checkoutPath}/which.txt`)).toBe(
        "main\n",
      );
    });
  });

  it("does not turn a Workspace that cannot retain the result into a refusal", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    // The Repository's own import writes the checkout's `.git/HEAD` once. The
    // second write of it is the switch importing what Git produced, which is
    // the one this run cannot retain.
    let imports = 0;

    yield* withStorage(
      root,
      function* () {
        const database = yield* createRun();
        const failure = yield* raised(
          runDocument(
            database,
            [
              "<PrintErrors>",
              document(remote.locator, `<Git.Switch branch="release" />`),
              "",
              "later",
              "</PrintErrors>",
            ].join("\n"),
          ),
        );

        expect(failure).not.toBe(undefined);
        expect(causedBy(failure, isGitFailure)).toBe(undefined);
        // Nothing was committed for the effect that could not be retained, so
        // the checkout is still where the Repository left it.
        expect(yield* gitEvents(database)).toHaveLength(0);
        const [repository] = yield* retainedRepositories(database);
        expect(yield* workspaceText(database, `${repository?.record.checkoutPath}/which.txt`)).toBe(
          "main\n",
        );
        expect(imports).toBeGreaterThan(1);
      },
      {
        decorateFilesystem: (filesystem: DenoWorkspaceFilesystem) => ({
          ...filesystem,
          *writeFile(target: string, content: string | Uint8Array, mode?: number) {
            if (target.endsWith("/.git/HEAD")) {
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
});

/**
 * A second physical copy of the Api module routes to the installed provider.
 *
 * State shared across loaded copies is shared by stable name, not by module
 * identity: two copies of `git-api.ts` create two different `Api` objects, and
 * both have to reach the one provider a host installed. What a copy does not get
 * is authority — its request is read by the same provider, against the same
 * retained rows, and a request naming something this run does not hold is
 * refused exactly as the packaged component's would be.
 */
describe("workflow Git composition routing", () => {
  it("routes a loaded copy's Api to the installed provider without sharing authority", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const copy = yield* physicalGitApiCopy();
    expect(copy.GitComposition).not.toBe(GitComposition);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const output = yield* scoped(function* () {
        return yield* withWorkflowWorkspace(
          database,
          scoped(function* () {
            yield* registerComponents([probe(copy, (repository) => repository)]);
            return yield* collect(
              yield* execute({
                ...inlineSource(
                  document(
                    remote.locator,
                    "<Probe />",
                    `<File path="which.txt" as="which" />`,
                    "",
                    "after: {which}",
                  ),
                ),
                stream: database.journal,
              }),
            );
          }),
        );
      });

      // Two `Api` objects, one provider: the name is the routing, and the copy
      // performed a real effect through the installed one.
      expect(String(output)).toContain("after: release");
      const outcomes = yield* gitOutcomes(database);
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["ok"]);

      // What the copy does not get is authority. Its request is read against the
      // same retained rows, and one naming something this run does not hold
      // fails the run rather than being answered.
      const forgedRun = yield* createRun({ runId: "loaded-copy-forged" });
      const failure = yield* raised(
        scoped(function* () {
          return yield* withWorkflowWorkspace(
            forgedRun,
            scoped(function* () {
              yield* registerComponents([probe(copy, () => FORGED)]);
              return yield* collect(
                yield* execute({
                  ...inlineSource(document(remote.locator, "<Probe />")),
                  stream: forgedRun.journal,
                }),
              );
            }),
          );
        }),
      );
      expect(causedBy(failure, isAuthorityFailure)).toBeInstanceOf(GitOperationAuthorityError);
      expect(causedBy(failure, isProviderError)).toBe(undefined);
      expect(yield* gitEvents(forgedRun)).toHaveLength(0);
    });
  });
});

/** A component that switches through a loaded copy's Api, on a chosen record. */
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
      yield* copy.GitComposition.operations.switchBranch({
        repository: observe(repository),
        workingDirectory: yield* cwd(),
        branch: "release",
        base: undefined,
      });
      return "";
    },
  };
}

/** The same members a request declares, as a caller is free to hold them. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface MutableSwitchRequest {
  repository: Mutable<RepositorySelection>;
  workingDirectory: string;
  branch: string;
  base: string | undefined;
}

/**
 * Admission takes a snapshot, and the snapshot is what runs.
 *
 * A caller's request is the caller's object: `switchBranch()` is public, a
 * mutable object satisfies a readonly interface, and the record inside it is
 * mutable too. Between naming itself and spawning Git this operation suspends
 * several times, so a step that read that object again instead of what
 * admission returned could identify one branch change, perform a second, retain
 * a third and read the result back against a fourth — against a Repository
 * record the run never authenticated.
 *
 * The mutation lands at a real point in the operation rather than at a guessed
 * moment: the injected host performs it when the effect acquires its
 * materialization directory, which is inside the transaction, after the durable
 * identity exists and before any Git command is given.
 */
describe("workflow Git.Switch request ownership", () => {
  it("switches the branch it admitted, not what the caller changed it to", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, "release-1.4");
    let caller: MutableSwitchRequest | undefined;
    let armed = false;
    let synchronized = false;

    const asked: ComponentRegistration = {
      name: "Probe",
      origin: "test",
      props: { type: "object", additionalProperties: false },
      *fn(): Operation<string> {
        const repository = yield* currentRepository();
        if (repository === undefined) {
          throw new Error("the probe was written outside a Repository");
        }
        const request: MutableSwitchRequest = {
          repository: { ...repository },
          workingDirectory: yield* cwd(),
          branch: "release",
          base: undefined,
        };
        caller = request;
        armed = true;
        yield* GitComposition.operations.switchBranch(request);
        return "";
      },
    };

    const source = document(
      remote.locator,
      "<Probe />",
      `<File path="which.txt" as="which" />`,
      "",
      "after: {which}",
    );

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const perform = (options: WorkflowWorkspaceOptions): Operation<Json> =>
        scoped(function* () {
          return yield* withWorkflowWorkspace(
            database,
            scoped(function* () {
              yield* registerComponents([asked]);
              return yield* collect(
                yield* execute({ ...inlineSource(source), stream: database.journal }),
              );
            }),
            options,
          );
        });

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
            request.branch = "feature/mutated";
            request.base = remote.heads.get("main");
            request.repository.name = "ghost";
          }
          return directory;
        },
      });

      const output = yield* perform(countingOptions(counting));

      // The premise: the caller's request really changed, at a point the
      // operation really reached.
      expect(synchronized).toBe(true);
      expect(caller?.branch).toBe("feature/mutated");
      expect(caller?.base).toBe(remote.heads.get("main"));
      expect(caller?.repository.name).toBe("ghost");

      // Git was given the branch that was admitted, as the only switch, and was
      // never asked to create one from the base that appeared afterwards.
      expect(counting.counters.commands.filter((command) => command[0] === "switch")).toEqual([
        ["switch", "release", "--"],
      ]);
      expect(String(output)).toContain("after: release");
      expect(counting.counters.effects).toEqual(["repository:project", "git:switch"]);

      // What it retained says the same thing, and is read back for the request
      // that was admitted rather than for the one the caller holds.
      const [outcome] = yield* gitOutcomes(database);
      expect(outcome?.status).toBe("ok");
      const retained = parseGitSwitchResult(
        outcome?.record,
        yield* expectation(database, "release"),
      );
      expect(retained?.checkout.repositoryName).toBe("project");
      expect(retained?.checkout.worktreeName).toBe(null);
      expect(retained?.requestedBranch).toBe("release");
      expect(retained?.requestedBase).toBe(null);
      expect(retained?.resolvedBranch).toBe("release");
      expect(retained?.resolvedBase).toBe(null);
      expect(retained?.after.commit).toBe(remote.heads.get("release"));

      // And so does the effect's own durable identity, which is the admitted
      // Repository record and the admitted branch, digested.
      const [repository] = yield* retainedRepositories(database);
      const record = repository?.record;
      if (record === undefined) {
        throw new Error("the run retained no repository");
      }
      const [event] = yield* gitEvents(database);
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
          "release",
          null,
        ]),
      );

      // Replaying the original invocation is that invocation: it builds the
      // identity the admitted values produced, so the recorded result answers
      // it with no Git and no second transition.
      const published = publishedRoots(path);
      dropRootClose(path);
      yield* remote.remove();

      const replayed = countingHost();
      const again = yield* perform(countingOptions(replayed));

      expect(String(again)).toContain("after: release");
      expect(subcommands(replayed.counters)).not.toContain("switch");
      expect(yield* gitEvents(database)).toHaveLength(1);
      expect(publishedRoots(path)).toBe(published);
    });
  });
});
