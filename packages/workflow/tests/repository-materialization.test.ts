/**
 * Tier WF — the export native Git is allowed to see.
 *
 * The materialization is a copy of what the database holds, and every claim this
 * provider makes rests on that: deleting one costs time and nothing else. These
 * are the rules about the checkout root itself — that it is a real retained
 * directory and that the export lands where it was aimed — and the control that
 * says ordinary tracked symbolic links inside a checkout are still content.
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
 * Native Git may only operate on the provider-owned export of the retained
 * checkout.
 *
 * The materialization is a copy of what the database holds, and every claim this
 * provider makes rests on that: deleting one costs time and nothing else,
 * because the database is where the run's Git state is. A checkout root that is
 * a symbolic link breaks it in a way no identity check would notice — the
 * operating system resolves a working directory before Git ever sees it, so Git
 * runs against whatever is at the other end while every question about origin,
 * object format and creation commit is answered by that same external
 * repository.
 *
 * Which is why these use a *compatible* external clone. An unrelated repository
 * would be caught by checks that already exist, and a regression that passed for
 * that reason would prove nothing about containment.
 */
describe("workflow Repository materialization containment", () => {
  /** A real, compatible clone of `locator`, outside the run and outside its export. */
  function* useExternalClone(locator: string): Operation<string> {
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

  it("refuses a Repository checkout root that is a link to an external clone", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const external = yield* useExternalClone(remote.locator);

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
      yield* linkWorkspacePath(database, external, before?.record.checkoutPath ?? "");

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
      expect(failure).toBeInstanceOf(RepositoryStaleStateError);
      expect(failure).toBeInstanceOf(StaleInputError);
      expect(failure?.message).toContain("is not a directory");

      // Nothing ran under it, nothing followed it, and Git was never invoked
      // against the external clone.
      expect(String(rendered)).not.toContain("child marker");
      expect(String(rendered)).not.toContain("later sibling marker");
      expect(counting.counters.commands).toEqual([]);

      // The external clone is untouched, and so is the run.
      expect((yield* until(stat(external))).isDirectory()).toBe(true);
      expect(yield* retainedRepositories(database)).toEqual([before]);
      expect(committedRoot(runPath(root, "release-1.4"))).toBe(frontier);
      expect(committedCompositionEvents(runPath(root, "release-1.4"))).toBe(events);
    });
  });

  it("refuses a checkout root that is a file", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const document = `<Repository name="project" url="${remote.locator}" as="repository" />`;
      yield* runDocument(database, document);
      const [before] = yield* retainedRepositories(database);
      const checkout = before?.record.checkoutPath ?? "";

      const replaced = yield* transactWorkspaceRoots(database, function* (workspace) {
        yield* workspace.filesystem.remove(checkout, { recursive: true, force: true });
        yield* workspace.filesystem.writeFile(checkout, "not a checkout");
        const captured = yield* workspace.capture();
        yield* workspace.publish(captured.rootId);
      });
      if (!replaced.ok) {
        throw replaced.error;
      }
      dropRootClose(runPath(root, "release-1.4"));

      const counting = countingHost();
      const failure = causedBy(
        yield* raised(runDocument(database, document, countingOptions(counting))),
        isStale,
      );
      expect(failure?.message).toContain("is not a directory");
      expect(counting.counters.commands).toEqual([]);
    });
  });

  /**
   * The rule is about the root and only the root.
   *
   * A symbolic link inside a repository is content Git tracks, and a checkout
   * holding one has to keep attaching — otherwise the containment fix would have
   * made ordinary repositories unusable, which is the failure mode a narrow
   * rule exists to avoid.
   */
  it("still attaches a checkout holding ordinary symbolic links", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote({
      commits: [
        {
          message: "with links",
          entries: [
            { path: "which.txt", content: "first\n" },
            { path: "link.txt", symlink: "which.txt" },
            { path: "nested/up.txt", symlink: "../which.txt" },
            { path: "escaping.txt", symlink: "/etc/hosts" },
          ],
        },
      ],
    });

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const document = [
        `<Repository name="project" url="${remote.locator}">`,
        "child marker",
        "</Repository>",
      ].join("\n");

      yield* runDocument(database, document);
      dropRootClose(runPath(root, "release-1.4"));

      const counting = countingHost();
      const rendered = String(yield* runDocument(database, document, countingOptions(counting)));

      // Attached and continued, including with a link whose target leaves the
      // Workspace entirely: it is content, and nothing resolves it.
      expect(rendered).toContain("child marker");
      expect(subcommands(counting.counters)).not.toContain("clone");

      const [repository] = yield* retainedRepositories(database);
      const link = yield* workspaceEntry(database, `${repository?.record.checkoutPath}/link.txt`);
      expect(link.kind).toBe("symlink");
      expect(link.target).toBe("which.txt");
      const escaping = yield* workspaceEntry(
        database,
        `${repository?.record.checkoutPath}/escaping.txt`,
      );
      expect(escaping.target).toBe("/etc/hosts");
    });
  });
});
