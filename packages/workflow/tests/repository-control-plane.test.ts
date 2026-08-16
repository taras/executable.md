/**
 * Tier WF — Git's control plane, as distinct from the content around it.
 *
 * The checkout root is a real directory in all of these. What differs is `.git`
 * — the entry that decides which repository native Git is operating on — and
 * the pointers a linked worktree is made of. A compatible external clone is used
 * throughout, because an incompatible one is refused by identity checks that
 * already exist and would make each of these pass for the wrong reason.
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
  committedRoot,
  changedExactlyOne,
  damageCheckoutPath,
  dropRootClose,
  isStale,
  latestRoot,
  publishedRoots,
  REMOTE,
  source,
} from "./support/replay.ts";

/**
 * Git's control plane, as distinct from the content around it.
 *
 * The checkout root is a real directory in every one of these. What differs is
 * `.git` — the entry that decides which repository native Git is operating on,
 * and the pointers a linked worktree is made of. A compatible external clone is
 * used throughout, because an incompatible one is refused by identity checks
 * that already exist and would make each of these pass for the wrong reason.
 */
describe("workflow Git control-plane containment", () => {
  function* useExternalRepository(locator: string): Operation<string> {
    return yield* resource<string>(function* (provide) {
      const directory = yield* until(mkdtemp(join(tmpdir(), "xmd-external-")));
      yield* ensure(function* () {
        yield* until(rm(directory, { recursive: true, force: true }));
      });
      git(
        ["clone", "--no-hardlinks", "--", locator, `${directory}/checkout`],
        directory,
        directory,
      );
      yield* provide(`${directory}/checkout`);
    });
  }

  it("refuses a Repository whose .git is a link to a compatible external clone", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const external = yield* useExternalRepository(remote.locator);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const document = [
        `<Repository name="project" url="${remote.locator}">`,
        "child marker",
        "</Repository>",
        "later sibling marker",
      ].join("\n");

      yield* runDocument(database, document);
      const [before] = yield* retainedRepositories(database);
      const checkout = before?.record.checkoutPath ?? "";

      // The checkout root stays a real retained directory. Only the control
      // plane inside it is redirected.
      yield* linkWorkspacePath(database, `${external}/.git`, `${checkout}/.git`);
      const externalHead = yield* readTextFile(`${external}/.git/HEAD`);
      const frontier = committedRoot(runPath(root, "release-1.4"));
      const events = committedCompositionEvents(runPath(root, "release-1.4"));
      dropRootClose(runPath(root, "release-1.4"));

      const counting = countingHost();
      const rendered = yield* raised(
        runDocument(
          database,
          ["<PrintErrors>", document, "</PrintErrors>"].join("\n"),
          countingOptions(counting),
        ),
      );

      const failure = causedBy(rendered, isStale);
      expect(failure).toBeInstanceOf(StaleInputError);
      expect(failure?.message).toContain("the `.git` in the checkout it holds is not a real");

      // Before Git, and before anything under or after the element.
      expect(counting.counters.commands).toEqual([]);
      expect(String(rendered)).not.toContain("child marker");
      expect(String(rendered)).not.toContain("later sibling marker");

      // The external clone and the run are both exactly as they were.
      expect(yield* readTextFile(`${external}/.git/HEAD`)).toBe(externalHead);
      expect(yield* retainedRepositories(database)).toEqual([before]);
      expect(committedRoot(runPath(root, "release-1.4"))).toBe(frontier);
      expect(committedCompositionEvents(runPath(root, "release-1.4"))).toBe(events);
    });
  });

  it("refuses a Worktree .git pointing outside the export with a relative path", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const external = yield* useExternalRepository(remote.locator);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const document = [
        `<Repository name="project" url="${remote.locator}">`,
        `<Worktree name="implementation" branch="feature/new" as="worktree" />`,
        "child marker",
        "</Repository>",
      ].join("\n");

      yield* runDocument(database, document);
      const [before] = yield* retainedWorktrees(database, "project");

      // A real regular `.git` file, with a traversal-shaped pointer at
      // compatible external administration. No symbolic link involved.
      yield* writeWorkspaceFile(
        database,
        `${before?.checkoutPath}/.git`,
        `gitdir: ../../../../..${external}/.git\n`,
      );
      dropRootClose(runPath(root, "release-1.4"));

      const counting = countingHost();
      const rendered = yield* raised(runDocument(database, document, countingOptions(counting)));

      expect(causedBy(rendered, isStale)?.message).toContain(
        "does not name one place beneath the Workspace root",
      );
      // The enclosing Repository attaches first and reads its own checkout, so
      // the claim is about what the *worktree* provoked: nothing was cloned and
      // no worktree command ran against the administration it named.
      expect(subcommands(counting.counters)).not.toContain("clone");
      expect(subcommands(counting.counters)).not.toContain("worktree");
      expect(String(rendered)).not.toContain("child marker");
      expect(yield* retainedWorktrees(database, "project")).toEqual([before]);
    });
  });

  it("refuses a Worktree .git naming an administration directory that is not the repository's", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const document = [
        `<Repository name="project" url="${remote.locator}">`,
        `<Worktree name="implementation" branch="feature/new" as="worktree" />`,
        "child marker",
        "</Repository>",
      ].join("\n");

      yield* runDocument(database, document);
      const [before] = yield* retainedWorktrees(database, "project");
      const [repository] = yield* retainedRepositories(database);

      // A canonical Workspace path that is not a slot this repository has.
      yield* writeWorkspaceFile(
        database,
        `${before?.checkoutPath}/.git`,
        `gitdir: ${repository?.record.checkoutPath}/.git/worktrees/invented\n`,
      );
      dropRootClose(runPath(root, "release-1.4"));

      const counting = countingHost();
      const rendered = yield* raised(runDocument(database, document, countingOptions(counting)));

      expect(causedBy(rendered, isStale)?.message).toContain(
        "names an administration directory the repository it belongs to does not have",
      );
      expect(subcommands(counting.counters)).not.toContain("clone");
      expect(subcommands(counting.counters)).not.toContain("worktree");
      expect(String(rendered)).not.toContain("child marker");
    });
  });

  it("cannot read or rewrite an external sentinel through a linked .git/worktrees", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    // An external administration tree holding one slot with a sentinel pointer.
    const external = yield* until(mkdtemp(join(tmpdir(), "xmd-external-admin-")));
    yield* ensure(function* () {
      yield* until(rm(external, { recursive: true, force: true }));
    });
    const SENTINEL = "SENTINEL — untouched\n";
    yield* until(mkdir(`${external}/slot`, { recursive: true }));
    yield* until(writeFile(`${external}/slot/gitdir`, SENTINEL));

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const document = [
        `<Repository name="project" url="${remote.locator}">`,
        "child marker",
        "</Repository>",
      ].join("\n");

      yield* runDocument(database, document);
      const [before] = yield* retainedRepositories(database);
      yield* linkWorkspacePath(database, external, `${before?.record.checkoutPath}/.git/worktrees`);
      dropRootClose(runPath(root, "release-1.4"));

      const counting = countingHost();
      const rendered = yield* raised(runDocument(database, document, countingOptions(counting)));

      expect(causedBy(rendered, isStale)?.message).toContain(
        "`.git/worktrees` is not a real directory",
      );
      expect(counting.counters.commands).toEqual([]);
      expect(String(rendered)).not.toContain("child marker");

      // Neither read into a rewrite nor written back over.
      expect(yield* readTextFile(`${external}/slot/gitdir`)).toBe(SENTINEL);
    });
  });

  it("still attaches a valid linked worktree, repeatedly", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const document = [
        `<Repository name="project" url="${remote.locator}">`,
        `<Worktree name="implementation" branch="feature/new" as="worktree" />`,
        "<Dir path={worktree}>",
        `<File path="which.txt" as="which" />`,
        "",
        "inside: {which}",
        "</Dir>",
        "</Repository>",
      ].join("\n");

      yield* runDocument(database, document);
      dropRootClose(runPath(root, "release-1.4"));

      // The control the containment rules must not break: administration Git
      // itself wrote, localized and validated on every attachment.
      const counting = countingHost();
      const rendered = String(yield* runDocument(database, document, countingOptions(counting)));
      expect(rendered).toContain("inside: first");
      expect(subcommands(counting.counters)).not.toContain("clone");

      dropRootClose(runPath(root, "release-1.4"));
      const again = String(yield* runDocument(database, document, countingOptions(counting)));
      expect(again).toContain("inside: first");
    });
  });
});

/**
 * A slot is a pair, or the repository's record of its worktrees is incomplete.
 *
 * `git worktree add` writes the administration directory and its `gitdir`
 * pointer together, so a slot without one is not a stage of anything. It is
 * missing authoritative state — and native Git answers every attachment
 * identity query regardless, because none of them consults the reciprocal
 * pointer. Only the control-plane proof can notice.
 */
describe("workflow Git control-plane completeness", () => {
  it("refuses a slot whose reciprocal gitdir is gone", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const document = [
        `<Repository name="project" url="${remote.locator}">`,
        `<Worktree name="implementation" branch="feature/new" as="worktree" />`,
        "child marker",
        "</Repository>",
        "later sibling marker",
      ].join("\n");

      yield* runDocument(database, document);
      const [repository] = yield* retainedRepositories(database);
      const [worktree] = yield* retainedWorktrees(database, "project");

      // The slot Git wrote, found the way the validator finds it.
      const pointer = yield* workspaceText(database, `${worktree?.checkoutPath}/.git`);
      const slot = pointer.trim().slice("gitdir: ".length);

      // Delete only the reciprocal. Everything else — the checkout, the slot
      // directory, the worktree's own `.git` — is exactly as Git left it.
      yield* removeWorkspacePath(database, `${slot}/gitdir`);

      const frontier = committedRoot(runPath(root, "release-1.4"));
      const events = committedCompositionEvents(runPath(root, "release-1.4"));
      dropRootClose(runPath(root, "release-1.4"));

      const counting = countingHost();
      const rendered = yield* raised(runDocument(database, document, countingOptions(counting)));

      const failure = causedBy(rendered, isStale);
      expect(failure).toBeInstanceOf(StaleInputError);
      expect(failure?.message).toContain("has no real `gitdir` pointer");

      // Before any Worktree-scoped Git command, and before anything under or
      // after the element.
      expect(subcommands(counting.counters)).not.toContain("worktree");
      expect(subcommands(counting.counters)).not.toContain("clone");
      expect(String(rendered)).not.toContain("child marker");
      expect(String(rendered)).not.toContain("later sibling marker");

      // Nothing was repaired and nothing advanced.
      expect(yield* retainedRepositories(database)).toEqual([repository]);
      expect(yield* retainedWorktrees(database, "project")).toEqual([worktree]);
      expect(committedRoot(runPath(root, "release-1.4"))).toBe(frontier);
      expect(committedCompositionEvents(runPath(root, "release-1.4"))).toBe(events);
    });
  });
});
