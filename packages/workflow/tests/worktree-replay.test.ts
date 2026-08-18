/**
 * Tier WF — what a `<Worktree>` replays and refuses.
 *
 * A Worktree's identity is its Repository's plus its own name, so the cases
 * that matter are the ones where those two disagree: a checkout standing in a
 * worktree's place, and administration that names something other than the
 * Repository the run says it belongs to.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, spawn, suspend, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { exists, lstat, readTextFile } from "@effectionx/fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StaleInputError } from "@executablemd/durable-streams";
import {
  RepositoryCompositionError,
  RepositoryStaleStateError,
} from "../src/composition/errors.ts";
import type { WorkflowRunDatabase } from "../src/storage/api.ts";
import { exportTree, importTree } from "../src/deno/composition/materialize.ts";
import { denoRepositoryHost } from "../src/deno/composition/host.ts";
import type { GitInvocation, GitOutcome } from "../src/deno/composition/host.ts";
import { transactWorkspaceRoots } from "../src/deno/workspace/private.ts";
import type { DenoWorkspaceFilesystem } from "../src/deno/workspace/filesystem.ts";
import { throwWorkspaceFilesystemFailure } from "../src/deno/workspace/errors.ts";
import { createRun, runPath, tamper, useStorageRoot, withStorage } from "./support/storage.ts";
import { git, useBareRemote } from "./support/git-remotes.ts";
import {
  causedBy,
  compositionEvents,
  countingHost,
  countingOptions,
  linkWorkspacePath,
  raised,
  removeWorkspacePath,
  replaceWorkspaceTree,
  retainedRepositories,
  retainedWorktrees,
  runDocument,
  subcommands,
  survivingRoots,
  workspaceEntry,
  workspaceText,
  writeWorkspaceFile,
} from "./support/composition.ts";
import {
  committedCompositionEvents,
  compositionResults,
  committedRoot,
  changedExactlyOne,
  damageCheckoutPath,
  dropRootClose,
  isStale,
  latestRoot,
  publishedRoots,
  REMOTE,
  source,
  substitute,
} from "./support/replay.ts";

/**
 * Substituting one repository's checkout for another's.
 *
 * The bytes at a retained path are not the run's word by the time they are read
 * back. A valid checkout of a different repository is a perfectly readable Git
 * repository, so attachment that asked only "can Git read this" accepted one
 * identity's retained history against another identity's content: the document
 * carried on restoring recorded reads that no longer described what was there,
 * and every later live effect ran against the substitute.
 *
 * Each of these builds a real, valid checkout that differs from the retained one
 * in exactly one dimension of creation identity, so a passing test says which
 * check caught it rather than that something did.
 */
describe("workflow Worktree substituted checkouts", () => {
  /** A host directory holding `tree`, ready to be imported over `workspacePath`. */
  it("refuses a Worktree checkout that is not a worktree of its Repository", function* () {
    const root = yield* useStorageRoot();
    const a = yield* useBareRemote({
      commits: [{ message: "a", entries: [{ path: "which.txt", content: "repository A\n" }] }],
    });

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const document = [
        `<Repository name="project" url="${a.locator}">`,
        `<Worktree name="implementation" branch="feature/new" as="worktree" />`,
        "child marker",
        "</Repository>",
      ].join("\n");

      yield* runDocument(database, document);
      const [worktreeBefore] = yield* retainedWorktrees(database, "project");
      const checkout = worktreeBefore?.checkoutPath ?? "";

      // A whole repository of its own, cloned from the same remote, standing
      // where a linked worktree was retained. Its origin and object format both
      // agree; what it is not is a worktree of the retained Repository.
      const counting = countingHost();
      const staged = yield* substitute(counting.host, checkout, function* (target, home) {
        git(["clone", "--no-hardlinks", "--", a.locator, target], home, home);
      });
      yield* replaceWorkspaceTree(database, staged, checkout);
      dropRootClose(runPath(root, "release-1.4"));

      const rendered = yield* raised(runDocument(database, document, countingOptions(counting)));
      const failure = causedBy(rendered, isStale);
      // Caught by the control-plane rule before Git is reached at all: a whole
      // repository standing in a worktree's place has `.git` as a directory,
      // and a worktree's is a file. The refusal is earlier and more exact than
      // the linkage check that used to answer here.
      expect(failure?.message).toContain("the `.git` in the worktree it holds is not a real file");
      expect(String(rendered)).not.toContain("child marker");
      expect(subcommands(counting.counters)).not.toContain("clone");
      expect(subcommands(counting.counters)).not.toContain("worktree");
      expect(yield* retainedWorktrees(database, "project")).toEqual([worktreeBefore]);
    });
  });
});
