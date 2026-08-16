/**
 * Tier WF — what a `<Repository>` replays, refuses and leaves behind.
 *
 * Every replay here happens after the remote has been deleted, so what
 * continues the run is what the run retained or nothing does. The discriminating
 * observations are the Git subcommands a run issued — a replay that clones did
 * the work again — and the composition events in the journal, which say whether
 * an effect was appended a second time. Rendered text proves neither: an
 * element's own expansion is journaled too.
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

describe("workflow Repository replay", () => {
  it("reattaches a partial run without recreating anything", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runDocument(database, source(remote.locator));

      const before = (yield* compositionEvents(database)).length;
      expect(before).toBe(1);
      const [repository] = yield* retainedRepositories(database);

      dropRootClose(runPath(root, "release-1.4"));
      // Nothing outside the run's database survives: no remote to clone from,
      // and every materialization the first execution used is already gone.
      yield* remote.remove();

      const counting = countingHost();
      const output = yield* runDocument(
        database,
        source(remote.locator),
        countingOptions(counting),
      );

      expect(String(output)).toContain("inside: first");
      expect(subcommands(counting.counters)).not.toContain("clone");
      expect(subcommands(counting.counters)).not.toContain("worktree");
      expect((yield* compositionEvents(database)).length).toBe(before);

      // Attachment still happened, and it is what rebuilt the facade.
      expect(counting.counters.attachments).toEqual(["repository:project"]);

      const [repositoryAgain] = yield* retainedRepositories(database);
      expect(repositoryAgain?.record).toEqual(repository?.record);
      expect(yield* survivingRoots(counting.counters)).toEqual([]);
    });
  });

  it("attaches nothing when the root result is already recorded", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const first = yield* runDocument(database, source(remote.locator));

      yield* remote.remove();

      const counting = countingHost();
      const replayed = yield* runDocument(
        database,
        source(remote.locator),
        countingOptions(counting),
      );

      expect(String(replayed)).toBe(String(first));
      expect(counting.counters.commands).toEqual([]);
      expect(counting.counters.roots).toEqual([]);
      expect(counting.counters.effects).toEqual([]);
      expect(counting.counters.attachments).toEqual([]);
    });
  });

  it("fails closed when the retained checkout is gone", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runDocument(database, source(remote.locator));
      const [repository] = yield* retainedRepositories(database);

      dropRootClose(runPath(root, "release-1.4"));
      yield* removeWorkspacePath(database, repository?.record.checkoutPath ?? "");

      const counting = countingHost();
      const failure = yield* raised(
        runDocument(database, source(remote.locator), countingOptions(counting)),
      );

      const stale = causedBy(failure, isStale);
      expect(stale?.subject).toBe('repository "project"');
      // A durability failure, so no printing boundary may downgrade it.
      expect(stale).toBeInstanceOf(StaleInputError);
      // Nothing was recloned to make the run continue.
      expect(subcommands(counting.counters)).not.toContain("clone");
      expect(yield* survivingRoots(counting.counters)).toEqual([]);
    });
  });

  it("fails closed when the retained record no longer matches", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runDocument(database, source(remote.locator));

      dropRootClose(runPath(root, "release-1.4"));
      tamper(runPath(root, "release-1.4"), (raw) => {
        raw
          .prepare("UPDATE workspace_repositories SET creation_commit = ? WHERE name = ?")
          .run("0000000000000000000000000000000000000000", "project");
      });

      const counting = countingHost();
      const failure = yield* raised(
        runDocument(database, source(remote.locator), countingOptions(counting)),
      );

      expect(causedBy(failure, isStale)?.subject).toBe('repository "project"');
      expect(subcommands(counting.counters)).not.toContain("clone");
    });
  });

  it("stops a stale run before its children and its later siblings", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runDocument(database, source(remote.locator));
      const [repository] = yield* retainedRepositories(database);

      dropRootClose(runPath(root, "release-1.4"));
      yield* removeWorkspacePath(database, repository?.record.checkoutPath ?? "");

      const failure = yield* raised(
        runDocument(
          database,
          [
            "<PrintErrors>",
            `<Repository name="project" url="${remote.locator}">`,
            "child marker",
            "</Repository>",
            "later sibling marker",
            "</PrintErrors>",
          ].join("\n"),
        ),
      );

      // `<PrintErrors>` covers the region and still does not print this: a
      // durability failure is not a decision about what the document reports.
      expect(causedBy(failure, isStale)).toBeInstanceOf(RepositoryStaleStateError);
    });
  });
});

describe("workflow Repository effect transaction", () => {
  it("leaves the frontier untouched when retention fails part-way", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, "release-1.4");

    yield* withStorage(
      root,
      function* () {
        const database = yield* createRun();
        const events = committedCompositionEvents(path);
        const rootBefore = committedRoot(path);

        const counting = countingHost();
        const failure = yield* raised(
          runDocument(
            database,
            `<Repository name="project" url="${remote.locator}" as="repository" />`,
            countingOptions(counting),
          ),
        );

        expect(failure).not.toBe(undefined);
        // The import got as far as the repository's own files, which land after
        // its `.git` administration: the failure is genuinely part-way through.
        expect(subcommands(counting.counters)).toContain("clone");

        // Nothing crossed the boundary. No metadata, no new root, no event.
        expect(yield* retainedRepositories(database)).toHaveLength(0);
        expect(committedCompositionEvents(path)).toBe(events);
        expect(committedRoot(path)).toBe(rootBefore);
        expect(yield* survivingRoots(counting.counters)).toEqual([]);
      },
      {
        decorateFilesystem: (filesystem: DenoWorkspaceFilesystem) => ({
          ...filesystem,
          *writeFile(target: string, content: string | Uint8Array, mode?: number) {
            if (target.endsWith("/which.txt")) {
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

  it("leaves the frontier untouched when a blocked Git command is halted", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, "release-1.4");

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const events = committedCompositionEvents(path);
      const rootBefore = committedRoot(path);

      const inner = denoRepositoryHost();
      const blocked = withResolvers<void>();
      const roots: string[] = [];
      const host = {
        *git(invocation: GitInvocation): Operation<GitOutcome> {
          if (invocation.args[0] === "clone") {
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
          runDocument(
            database,
            `<Repository name="project" url="${remote.locator}" as="repository" />`,
            { composition: { host } },
          ),
        );
        yield* blocked.operation;
        yield* task.halt();
      });

      expect(yield* retainedRepositories(database)).toHaveLength(0);
      expect(committedCompositionEvents(path)).toBe(events);
      expect(committedRoot(path)).toBe(rootBefore);
      const surviving: string[] = [];
      for (const directory of roots) {
        if (yield* exists(directory)) {
          surviving.push(directory);
        }
      }
      expect(surviving).toEqual([]);
    });
  });
});

describe("workflow Repository refusal durability", () => {
  it("fails the run on a refusal, leaving one err outcome and the root unmoved", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, "release-1.4");

    yield* withStorage(root, function* () {
      const database = yield* createRun();

      // One Repository that succeeds, then one that refuses. The successful one
      // is what makes the claim discriminating: this run does publish a root,
      // so "no root moved" is about the refusal rather than about a run that
      // never wrote anything.
      let rendered = "";
      let failure: unknown;
      try {
        rendered = String(
          yield* runDocument(
            database,
            [
              `<Repository name="project" url="${remote.locator}" />`,
              `<Repository name="second" url="${remote.locator}" base="no-such-ref" />`,
              "",
              "later sibling marker",
            ].join("\n"),
          ),
        );
      } catch (error) {
        failure = error;
      }

      // Written plainly, so the refusal is what it is: a failure of the run,
      // reported with the fixed word, with nothing after it executed.
      expect(failure).toBeInstanceOf(RepositoryCompositionError);
      expect(String(failure)).toContain("does not name a commit");
      expect(rendered).not.toContain("later sibling marker");

      // And retained as a failure. This is the claim the plan makes: the run's
      // own history says the operation did not succeed.
      const results = yield* compositionResults(database);
      expect(results).toHaveLength(2);
      expect(results[0]?.status).toBe("ok");
      expect(results[1]?.status).toBe("err");
      expect(results[1]?.name).toBe("RepositoryCompositionRefusal:unresolved-base");

      // The diagnostic the journal carries is the component's own sentence:
      // nothing Git printed, no locator, no host path.
      expect(results[1]?.message).toContain("could not be prepared");
      expect(results[1]?.message).not.toContain(remote.locator);

      // Exactly one root was published, by the effect that succeeded. A refusal
      // that had published its own would leave a second, and the run would be
      // pointing at a Workspace no successful effect produced.
      expect(publishedRoots(path)).toBe(1);
      expect(committedRoot(path)).toBe(latestRoot(path));

      // And it retained nothing of its own.
      expect(yield* retainedRepositories(database)).toHaveLength(1);
    });
  });

  it("prints a refusal once inside <PrintErrors> and continues without repeating it", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, "release-1.4");

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const rendered = String(
        yield* runDocument(
          database,
          [
            "<PrintErrors>",
            `<Repository name="second" url="${remote.locator}" base="no-such-ref" />`,
            "",
            "later sibling marker",
            "</PrintErrors>",
          ].join("\n"),
        ),
      );

      // The region decided: printed once, and what follows it ran.
      expect(rendered.match(/<!-- ERROR:[^]*?-->/g)).toHaveLength(1);
      expect(rendered).toContain("does not name a commit");
      expect(rendered).toContain("later sibling marker");

      // Printing changed what the document reports and nothing about what was
      // retained: one failed effect, no root published, no row.
      const results = yield* compositionResults(database);
      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe("err");
      expect(publishedRoots(path)).toBe(0);
      expect(yield* retainedRepositories(database)).toHaveLength(0);
    });
  });

  it("reconstructs the same refusal on replay without reaching a remote", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, "release-1.4");
    const document = [
      "<PrintErrors>",
      `<Repository name="project" url="${remote.locator}" base="no-such-ref" />`,
      "</PrintErrors>",
    ].join("\n");

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const first = String(yield* runDocument(database, document));
      const live = yield* compositionResults(database);
      const rootAfterLive = committedRoot(path);

      // Without this the second run replays to the recorded close and performs
      // nothing at all, which would make every claim below vacuously true.
      dropRootClose(path);
      const counting = countingHost();
      const second = String(yield* runDocument(database, document, countingOptions(counting)));

      // The same sentence, from a restored failure rather than a fresh one —
      // and it is a sentence, so neither run is quietly rendering nothing.
      expect(first).toContain("does not name a commit");
      expect(second).toBe(first);

      // Replay performed nothing: no clone, and no second effect appended.
      expect(subcommands(counting.counters)).not.toContain("clone");
      expect(yield* compositionResults(database)).toEqual(live);
      expect(committedRoot(path)).toBe(rootAfterLive);
    });
  });
});

describe("workflow Repository retained integrity", () => {
  it("refuses to join a traversal-shaped path to a materialization root", function* () {
    const root = yield* useStorageRoot();
    const host = join(yield* useStorageRoot(), "materialization");

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const escaped = join(host, "..", "..", "etc");

      // Straight at the join itself, because this is the one operation that
      // turns a retained string into a host location. Every route that reads a
      // damaged row is refused somewhere, but only this proves the refusal is
      // containment rather than some earlier check happening to notice.
      const attempted = yield* transactWorkspaceRoots(database, function* (workspace) {
        return yield* raised(exportTree(workspace.filesystem, host, "/../../etc", "a probe"));
      });
      expect(attempted.ok).toBe(true);
      expect(attempted.ok && attempted.value).toBeInstanceOf(RepositoryStaleStateError);

      const imported = yield* transactWorkspaceRoots(database, function* (workspace) {
        return yield* raised(importTree(workspace.filesystem, host, "/repositories/../../etc"));
      });
      expect(imported.ok).toBe(true);
      expect(imported.ok && imported.value).toBeInstanceOf(RepositoryStaleStateError);

      // And the refusal came before anything was created outside the root.
      expect(yield* exists(escaped)).toBe(false);
      expect(yield* exists(host)).toBe(false);
    });
  });

  it("refuses a traversal-shaped retained path before any host work", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, "release-1.4");

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runDocument(database, `<Repository name="project" url="${remote.locator}" />`);

      // A retained path that is not the one this identity's placement gives it.
      // Concatenated with a materialization root it would name a directory
      // outside the run's own tree entirely.
      dropRootClose(path);
      damageCheckoutPath(path, "project", "/../../etc");

      const counting = countingHost();
      const failure = yield* raised(
        runDocument(
          database,
          [
            "<PrintErrors>",
            `<Repository name="project" url="${remote.locator}">`,
            "child marker",
            "</Repository>",
            "later sibling marker",
            "</PrintErrors>",
          ].join("\n"),
          countingOptions(counting),
        ),
      );

      // Damaged retained state, not a refusal: fatal, and `<PrintErrors>` does
      // not get to downgrade it.
      const stale = causedBy(failure, isStale);
      expect(stale).toBeInstanceOf(RepositoryStaleStateError);
      expect(stale?.subject).toBe('repository "project"');

      // Refused before host work rather than after it: nothing was exported and
      // no Git ran against a path outside the materialization.
      expect(subcommands(counting.counters)).toEqual([]);
      expect(yield* survivingRoots(counting.counters)).toEqual([]);
    });
  });

  it("detects a mutated retained locator before children and later siblings", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const other = yield* useBareRemote({
      commits: [{ message: "other", entries: [{ path: "which.txt", content: "other\n" }] }],
    });
    const path = runPath(root, "release-1.4");

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runDocument(database, `<Repository name="project" url="${remote.locator}" />`);

      // Only the stored url changes. The fingerprint beside it — the identity
      // every comparison uses — is left as it was, which is what makes this a
      // disagreement rather than a different Repository.
      dropRootClose(path);
      changedExactlyOne(path, "UPDATE workspace_repositories SET locator = ? WHERE name = ?", [
        other.locator,
        "project",
      ]);

      const counting = countingHost();
      const failure = yield* raised(
        runDocument(
          database,
          [
            "<PrintErrors>",
            `<Repository name="project" url="${remote.locator}">`,
            "child marker",
            "</Repository>",
            "later sibling marker",
            "</PrintErrors>",
          ].join("\n"),
          countingOptions(counting),
        ),
      );

      const stale = causedBy(failure, isStale);
      expect(stale).toBeInstanceOf(RepositoryStaleStateError);

      // Nothing ran against the substituted remote, and no child or later
      // sibling reached the document.
      expect(subcommands(counting.counters)).not.toContain("clone");
      expect(String(failure)).not.toContain("child marker");
      expect(String(failure)).not.toContain("later sibling marker");
    });
  });
});

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
describe("workflow Repository substituted checkouts", () => {
  /** A host directory holding `tree`, ready to be imported over `workspacePath`. */
  it("refuses a valid checkout of a different repository", function* () {
    const root = yield* useStorageRoot();
    const a = yield* useBareRemote({
      commits: [{ message: "a", entries: [{ path: "which.txt", content: "repository A\n" }] }],
    });
    const b = yield* useBareRemote({
      commits: [{ message: "b", entries: [{ path: "which.txt", content: "repository B\n" }] }],
    });

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const document = [
        `<Repository name="project" url="${a.locator}">`,
        "child marker",
        "</Repository>",
        "later sibling marker",
      ].join("\n");

      yield* runDocument(database, document);
      const [before] = yield* retainedRepositories(database);
      const checkout = before?.record.checkoutPath ?? "";

      const counting = countingHost();
      const staged = yield* substitute(counting.host, checkout, function* (target, home) {
        git(["clone", "--no-hardlinks", "--", b.locator, target], home, home);
      });
      yield* replaceWorkspaceTree(database, staged, checkout);

      // Taken after the substitution, because the fixture publishes a root of
      // its own: what must not move is the frontier the replay finds.
      const frontier = committedRoot(runPath(root, "release-1.4"));
      const events = committedCompositionEvents(runPath(root, "release-1.4"));

      dropRootClose(runPath(root, "release-1.4"));

      const rendered = yield* raised(
        runDocument(
          database,
          ["<PrintErrors>", document, "</PrintErrors>"].join("\n"),
          countingOptions(counting),
        ),
      );

      // Fatal, and fatal past `<PrintErrors>`: a durability failure is not a
      // decision about what the document reports.
      const failure = causedBy(rendered, isStale);
      expect(failure).toBeInstanceOf(RepositoryStaleStateError);
      expect(failure).toBeInstanceOf(StaleInputError);
      expect(failure?.message).toContain("came from a different repository");

      // Nothing ran under it and nothing followed it.
      expect(String(rendered)).not.toContain("child marker");
      expect(String(rendered)).not.toContain("later sibling marker");

      // Nothing was recloned and nothing was repaired.
      expect(subcommands(counting.counters)).not.toContain("clone");
      expect(subcommands(counting.counters)).not.toContain("fetch");
      expect(subcommands(counting.counters)).not.toContain("checkout");
      expect(subcommands(counting.counters)).not.toContain("worktree");

      // The retained record and the frontier are exactly what they were.
      const [after] = yield* retainedRepositories(database);
      expect(after).toEqual(before);
      expect(committedRoot(runPath(root, "release-1.4"))).toBe(frontier);
      expect(committedCompositionEvents(runPath(root, "release-1.4"))).toBe(events);
    });
  });

  it("refuses a checkout wearing the right origin with the wrong history", function* () {
    const root = yield* useStorageRoot();
    const a = yield* useBareRemote({
      commits: [{ message: "a", entries: [{ path: "which.txt", content: "repository A\n" }] }],
    });
    const b = yield* useBareRemote({
      commits: [{ message: "b", entries: [{ path: "which.txt", content: "repository B\n" }] }],
    });

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const document = `<Repository name="project" url="${a.locator}" as="repository" />`;
      yield* runDocument(database, document);
      const [before] = yield* retainedRepositories(database);
      const checkout = before?.record.checkoutPath ?? "";

      // B's content, carrying A's locator as its origin. The url matches and the
      // object format matches; what is missing is A's creation commit.
      const counting = countingHost();
      const staged = yield* substitute(counting.host, checkout, function* (target, home) {
        git(["clone", "--no-hardlinks", "--", b.locator, target], home, home);
        git(["remote", "set-url", "origin", a.locator], target, home);
      });
      yield* replaceWorkspaceTree(database, staged, checkout);
      dropRootClose(runPath(root, "release-1.4"));

      const failure = causedBy(
        yield* raised(runDocument(database, document, countingOptions(counting))),
        isStale,
      );
      expect(failure?.message).toContain("the commit it was created at is not in the checkout");
      expect(subcommands(counting.counters)).not.toContain("clone");
      expect(yield* retainedRepositories(database)).toEqual([before]);
    });
  });

  it("refuses a checkout that names its objects differently", function* () {
    const root = yield* useStorageRoot();
    const a = yield* useBareRemote({
      commits: [{ message: "a", entries: [{ path: "which.txt", content: "repository A\n" }] }],
    });

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const document = `<Repository name="project" url="${a.locator}" as="repository" />`;
      yield* runDocument(database, document);
      const [before] = yield* retainedRepositories(database);
      expect(before?.record.objectFormat).toBe("sha1");
      const checkout = before?.record.checkoutPath ?? "";

      const counting = countingHost();
      const staged = yield* substitute(counting.host, checkout, function* (target, home) {
        git(["init", "--object-format=sha256", "--initial-branch=main", target], home, home);
        git(["remote", "add", "origin", a.locator], target, home);
        yield* until(writeFile(`${target}/which.txt`, "repository A\n"));
        git(["add", "--all", "--", "."], target, home);
        git(["commit", "--message", "impostor"], target, home);
      });
      yield* replaceWorkspaceTree(database, staged, checkout);
      dropRootClose(runPath(root, "release-1.4"));

      const failure = causedBy(
        yield* raised(runDocument(database, document, countingOptions(counting))),
        isStale,
      );
      expect(failure?.message).toContain("names its objects with a different algorithm");
      expect(subcommands(counting.counters)).not.toContain("clone");
    });
  });

  it("still attaches after a later Git effect would have moved HEAD", function* () {
    const root = yield* useStorageRoot();
    const a = yield* useBareRemote({
      commits: [
        { message: "a", entries: [{ path: "which.txt", content: "repository A\n" }] },
        {
          message: "later",
          branch: "feature/later",
          entries: [{ path: "which.txt", content: "moved on\n" }],
        },
      ],
    });

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const document = `<Repository name="project" url="${a.locator}" as="repository" />`;
      yield* runDocument(database, document);
      const [before] = yield* retainedRepositories(database);
      const checkout = before?.record.checkoutPath ?? "";

      // What #294 will do: the same repository, on another branch, at another
      // commit. Creation identity is unchanged, so attachment must accept it.
      const counting = countingHost();
      const staged = yield* substitute(counting.host, checkout, function* (target, home) {
        git(["clone", "--no-hardlinks", "--", a.locator, target], home, home);
        git(["checkout", "-B", "feature/later", "origin/feature/later"], target, home);
      });
      yield* replaceWorkspaceTree(database, staged, checkout);
      dropRootClose(runPath(root, "release-1.4"));

      const rendered = yield* raised(runDocument(database, document, countingOptions(counting)));
      expect(causedBy(rendered, isStale)).toBe(undefined);
      expect(subcommands(counting.counters)).not.toContain("clone");
    });
  });
});
