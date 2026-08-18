/**
 * Tier WF — what a Repository and a Worktree retain, and what they refuse.
 *
 * Every remote here is a real local bare repository and every Git command is
 * the real one. That is deliberate: what is under test is whether a run can be
 * continued from its own database after the remote is gone, and neither a
 * stand-in for Git nor a stand-in for DOFS could show that.
 *
 * Two observations do most of the work. The retained rows say what the run
 * decided its identity was, and the retained bytes say whether what it decided
 * is still there — including the one thing a materialization must never leave
 * behind, which is its own host path.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createRun, useStorageRoot, withStorage } from "./support/storage.ts";
import { git, moveRemoteBranch, useBareRemote } from "./support/git-remotes.ts";
import {
  countingHost,
  countingOptions,
  retainedRepositories,
  retainedWorktrees,
  runDocument,
  subcommands,
  workspaceEntry,
  workspaceText,
  workspaceTree,
} from "./support/composition.ts";

const decoder = new TextDecoder();

describe("workflow Repository retention", () => {
  it("keeps two remotes apart in identity, path and content", function* () {
    const root = yield* useStorageRoot();
    const api = yield* useBareRemote({
      commits: [{ message: "api", entries: [{ path: "service.txt", content: "api service\n" }] }],
    });
    const sdk = yield* useBareRemote({
      commits: [{ message: "sdk", entries: [{ path: "client.txt", content: "sdk client\n" }] }],
    });

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runDocument(
        database,
        [
          `<Repository name="api" url="${api.locator}">`,
          `<Worktree name="candidate" branch="api/candidate" as="apiWorktree" />`,
          "</Repository>",
          `<Repository name="sdk" url="${sdk.locator}">`,
          `<Worktree name="candidate" branch="sdk/candidate" as="sdkWorktree" />`,
          "</Repository>",
        ].join("\n"),
      );

      const repositories = yield* retainedRepositories(database);
      expect(repositories.map((entry) => entry.record.name)).toEqual(["api", "sdk"]);

      const apiWorktrees = yield* retainedWorktrees(database, "api");
      const sdkWorktrees = yield* retainedWorktrees(database, "sdk");

      const paths = [
        repositories[0]?.record.checkoutPath,
        repositories[1]?.record.checkoutPath,
        apiWorktrees[0]?.checkoutPath,
        sdkWorktrees[0]?.checkoutPath,
      ];
      expect(new Set(paths).size).toBe(4);

      // The same Worktree name in two repositories is two identities, and the
      // provider placed them apart rather than letting one land on the other.
      expect(apiWorktrees[0]?.name).toBe("candidate");
      expect(sdkWorktrees[0]?.name).toBe("candidate");

      expect(
        yield* workspaceText(database, `${repositories[0]?.record.checkoutPath}/service.txt`),
      ).toBe("api service\n");
      expect(
        yield* workspaceText(database, `${repositories[1]?.record.checkoutPath}/client.txt`),
      ).toBe("sdk client\n");
      expect(yield* workspaceText(database, `${apiWorktrees[0]?.checkoutPath}/service.txt`)).toBe(
        "api service\n",
      );
      expect(repositories[0]?.record.creationCommit).toBe(api.heads.get("main"));
      expect(repositories[1]?.record.creationCommit).toBe(sdk.heads.get("main"));
    });
  });

  it("follows the remote's own default branch when no base is given", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote({
      defaultBranch: "trunk",
      commits: [
        { message: "on trunk", entries: [{ path: "which.txt", content: "trunk\n" }] },
        {
          message: "on main",
          branch: "main",
          entries: [{ path: "which.txt", content: "main\n" }],
        },
      ],
    });

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runDocument(
        database,
        `<Repository name="project" url="${remote.locator}" as="repository" />`,
      );

      const [retained] = yield* retainedRepositories(database);
      expect(retained?.record.primaryBranch).toBe("trunk");
      expect(retained?.record.requestedBase).toBe(null);
      expect(retained?.record.creationCommit).toBe(remote.heads.get("trunk"));
      expect(yield* workspaceText(database, `${retained?.record.checkoutPath}/which.txt`)).toBe(
        "trunk\n",
      );
    });
  });

  it("pins the commit an explicit branch base named, and does not follow it later", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote({
      commits: [
        { message: "first", entries: [{ path: "which.txt", content: "first\n" }] },
        {
          message: "second on release",
          branch: "release",
          entries: [{ path: "which.txt", content: "release\n" }],
        },
      ],
    });

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runDocument(
        database,
        `<Repository name="project" url="${remote.locator}" base="release" as="repository" />`,
      );

      const [retained] = yield* retainedRepositories(database);
      expect(retained?.record.primaryBranch).toBe("release");
      expect(retained?.record.requestedBase).toBe("release");
      expect(retained?.record.creationCommit).toBe(remote.heads.get("release"));

      // Moving the branch afterwards changes neither the record nor what a
      // later read of the run finds: resolution happened once.
      moveRemoteBranch(remote, "release", remote.heads.get("main") ?? "");
      const again = yield* retainedRepositories(database);
      expect(again[0]?.record.creationCommit).toBe(remote.heads.get("release"));
      expect(yield* workspaceText(database, `${retained?.record.checkoutPath}/which.txt`)).toBe(
        "release\n",
      );
    });
  });

  it("names a branch of its own when the base is a tag rather than a branch", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote({
      commits: [
        { message: "first", entries: [{ path: "which.txt", content: "first\n" }], tag: "v1" },
        { message: "second", entries: [{ path: "which.txt", content: "second\n" }] },
      ],
    });

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runDocument(
        database,
        `<Repository name="project" url="${remote.locator}" base="v1" as="repository" />`,
      );

      const [retained] = yield* retainedRepositories(database);
      expect(retained?.record.primaryBranch).toBe("xmd/base");
      expect(retained?.record.creationCommit).toBe(remote.tags.get("v1"));

      // Never detached: the retained HEAD is a symbolic ref to the branch the
      // provider named, which is what a later Switch, Commit or Push needs.
      expect(yield* workspaceText(database, `${retained?.record.checkoutPath}/.git/HEAD`)).toBe(
        "ref: refs/heads/xmd/base\n",
      );
      expect(yield* workspaceText(database, `${retained?.record.checkoutPath}/which.txt`)).toBe(
        "first\n",
      );
    });
  });

  it("refuses a base that names no commit", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote({
      commits: [{ message: "first", entries: [{ path: "which.txt", content: "first\n" }] }],
    });

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const output = yield* runDocument(
        database,
        [
          "<PrintErrors>",
          `<Repository name="project" url="${remote.locator}" base="no-such-ref" as="repository" />`,
          "</PrintErrors>",
        ].join("\n"),
      );

      expect(String(output)).toContain("does not name a commit");
      expect(yield* retainedRepositories(database)).toHaveLength(0);
    });
  });

  it("reuses a compatible name and refuses a changed locator or base", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote({
      commits: [{ message: "first", entries: [{ path: "which.txt", content: "first\n" }] }],
    });
    const other = yield* useBareRemote({
      commits: [{ message: "other", entries: [{ path: "which.txt", content: "other\n" }] }],
    });

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const output = yield* runDocument(
        database,
        [
          "<PrintErrors>",
          `<Repository name="project" url="${remote.locator}" as="first" />`,
          `<Repository name="project" url="${remote.locator}" as="second" />`,
          `<Repository name="project" url="${other.locator}" as="third" />`,
          `<Repository name="project" url="${remote.locator}" base="main" as="fourth" />`,
          "",
          "first: {first}",
          "second: {second}",
          "</PrintErrors>",
        ].join("\n"),
      );

      const rendered = String(output);
      const [retained] = yield* retainedRepositories(database);
      const path = retained?.record.checkoutPath ?? "";

      // Compatible reuse addresses the same Repository rather than making a
      // second one.
      expect(rendered).toContain(`first: ${path}`);
      expect(rendered).toContain(`second: ${path}`);
      expect(yield* retainedRepositories(database)).toHaveLength(1);

      // A changed locator and a changed base are both incompatible reuse, and
      // neither repoints the name.
      expect(rendered).toContain("that name is already this run's, for a different url or base");
      expect(rendered.match(/already this run's/g)).toHaveLength(2);
      // Both refusals printed and the region carried on, which is what makes
      // "the name was not repointed" a claim about reuse rather than about a
      // run that stopped at the first refusal.
      expect(yield* retainedRepositories(database)).toHaveLength(1);
    });
  });

  it("retains bytes, modes and symbolic links as Git produced them", function* () {
    const root = yield* useStorageRoot();
    const binary = new Uint8Array([0, 1, 2, 250, 251, 252, 0]);
    const remote = yield* useBareRemote({
      commits: [
        {
          message: "first",
          entries: [
            { path: "text.txt", content: "plain\n" },
            { path: "blob.bin", content: binary },
            { path: "tool.sh", content: "#!/bin/sh\necho hi\n", mode: 0o755 },
            { path: "link.txt", symlink: "text.txt" },
          ],
        },
      ],
    });

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runDocument(
        database,
        `<Repository name="project" url="${remote.locator}" as="repository" />`,
      );

      const [retained] = yield* retainedRepositories(database);
      const checkout = retained?.record.checkoutPath ?? "";

      const tree = yield* workspaceTree(database, checkout);
      expect(tree.get(`${checkout}/blob.bin`)).toEqual(binary);

      const executable = yield* workspaceEntry(database, `${checkout}/tool.sh`);
      expect(executable.mode & 0o111).not.toBe(0);

      const link = yield* workspaceEntry(database, `${checkout}/link.txt`);
      expect(link.kind).toBe("symlink");
      expect(link.target).toBe("text.txt");
    });
  });

  it("retains no trace of the host directory Git ran in", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote({
      commits: [{ message: "first", entries: [{ path: "which.txt", content: "first\n" }] }],
    });

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();
      yield* runDocument(
        database,
        [
          `<Repository name="project" url="${remote.locator}">`,
          `<Worktree name="implementation" branch="feature/new" as="worktree" />`,
          "</Repository>",
        ].join("\n"),
        countingOptions(counting),
      );

      // Every materialization this run used, so the assertion covers the roots
      // that existed rather than one the suite guessed at.
      expect(counting.counters.roots.length).toBeGreaterThan(0);

      for (const prefix of ["/repositories", "/worktrees"]) {
        for (const [path, bytes] of yield* workspaceTree(database, prefix)) {
          const content = decoder.decode(bytes);
          expect({ path, holdsTempRoot: content.includes("xmd-workflow-git-") }).toEqual({
            path,
            holdsTempRoot: false,
          });
        }
      }
    });
  });
});

describe("workflow Worktree retention", () => {
  const REMOTE = {
    commits: [
      { message: "first", entries: [{ path: "which.txt", content: "first\n" }] },
      {
        message: "on feature",
        branch: "feature/existing",
        entries: [{ path: "which.txt", content: "feature\n" }],
      },
    ],
  } as const;

  it("creates a missing branch from the primary checkout's current commit", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runDocument(
        database,
        [
          `<Repository name="project" url="${remote.locator}">`,
          `<Worktree name="implementation" branch="feature/new" as="worktree" />`,
          "</Repository>",
        ].join("\n"),
      );

      const [worktree] = yield* retainedWorktrees(database, "project");
      expect(worktree?.requestedBranch).toBe("feature/new");
      expect(worktree?.requestedBase).toBe(null);
      expect(worktree?.creationCommit).toBe(remote.heads.get("main"));
      expect(yield* workspaceText(database, `${worktree?.checkoutPath}/which.txt`)).toBe("first\n");
    });
  });

  it("creates a missing branch from an explicit base", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runDocument(
        database,
        [
          `<Repository name="project" url="${remote.locator}">`,
          `<Worktree name="implementation" branch="feature/new" base="feature/existing" as="w" />`,
          "</Repository>",
        ].join("\n"),
      );

      const [worktree] = yield* retainedWorktrees(database, "project");
      expect(worktree?.requestedBase).toBe("feature/existing");
      expect(worktree?.creationCommit).toBe(remote.heads.get("feature/existing"));
      expect(yield* workspaceText(database, `${worktree?.checkoutPath}/which.txt`)).toBe(
        "feature\n",
      );
    });
  });

  it("checks out an existing branch rather than recreating it", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runDocument(
        database,
        [
          `<Repository name="project" url="${remote.locator}">`,
          `<Worktree name="a" branch="feature/existing" as="first" />`,
          "</Repository>",
        ].join("\n"),
      );

      const [worktree] = yield* retainedWorktrees(database, "project");
      // The existing branch's commit, not the primary checkout's: the branch
      // was used rather than recreated at HEAD.
      expect(worktree?.creationCommit).toBe(remote.heads.get("feature/existing"));
    });
  });

  it("refuses a branch another checkout already holds", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const output = yield* runDocument(
        database,
        [
          `<Repository name="project" url="${remote.locator}">`,
          "<PrintErrors>",
          `<Worktree name="first" branch="feature/existing" as="a" />`,
          `<Worktree name="second" branch="feature/existing" as="b" />`,
          "</PrintErrors>",
          "</Repository>",
        ].join("\n"),
      );

      expect(String(output)).toContain("already checked out by another worktree");
      expect(String(output)).toContain(
        "Nothing was moved, reset or detached to make room for this one",
      );

      // The first one survives untouched; the refusal added nothing.
      const worktrees = yield* retainedWorktrees(database, "project");
      expect(worktrees.map((entry) => entry.name)).toEqual(["first"]);
    });
  });

  it("refuses the primary checkout's own branch", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const output = yield* runDocument(
        database,
        [
          `<Repository name="project" url="${remote.locator}">`,
          "<PrintErrors>",
          `<Worktree name="implementation" branch="main" as="worktree" />`,
          "</PrintErrors>",
          "</Repository>",
        ].join("\n"),
      );

      expect(String(output)).toContain("already checked out by another worktree");
      expect(yield* retainedWorktrees(database, "project")).toHaveLength(0);
    });
  });

  it("reuses a compatible Worktree name", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const output = yield* runDocument(
        database,
        [
          `<Repository name="project" url="${remote.locator}">`,
          `<Worktree name="implementation" branch="feature/new" as="first" />`,
          `<Worktree name="implementation" branch="feature/new" as="second" />`,
          "",
          "first: {first}",
          "second: {second}",
          "</Repository>",
        ].join("\n"),
      );

      const rendered = String(output);
      const [worktree] = yield* retainedWorktrees(database, "project");
      expect(rendered).toContain(`first: ${worktree?.checkoutPath}`);
      expect(rendered).toContain(`second: ${worktree?.checkoutPath}`);
      expect(yield* retainedWorktrees(database, "project")).toHaveLength(1);
    });
  });

  it("refuses a reused Worktree name whose branch changed", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const output = yield* runDocument(
        database,
        [
          `<Repository name="project" url="${remote.locator}">`,
          "<PrintErrors>",
          `<Worktree name="implementation" branch="feature/new" as="first" />`,
          `<Worktree name="implementation" branch="feature/other" as="second" />`,
          "</PrintErrors>",
          "</Repository>",
        ].join("\n"),
      );

      expect(String(output)).toContain(
        "that name is already this repository's, for a different branch or base",
      );

      // The refusal moved nothing: the retained Worktree is the first one, on
      // the branch it was created for.
      const worktrees = yield* retainedWorktrees(database, "project");
      expect(worktrees).toHaveLength(1);
      expect(worktrees[0]?.requestedBranch).toBe("feature/new");
    });
  });

  it("keeps the repository and its worktree usable as one Git repository", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runDocument(
        database,
        [
          `<Repository name="project" url="${remote.locator}">`,
          `<Worktree name="implementation" branch="feature/new" as="worktree" />`,
          "</Repository>",
        ].join("\n"),
      );

      const [repository] = yield* retainedRepositories(database);
      const [worktree] = yield* retainedWorktrees(database, "project");

      // The two administration files that carry an absolute path hold Workspace
      // paths, which is what makes the pair relocatable to another host.
      const pointer = yield* workspaceText(database, `${worktree?.checkoutPath}/.git`);
      expect(pointer).toContain(`gitdir: ${repository?.record.checkoutPath}/.git/worktrees/`);

      const administration = pointer.trim().slice("gitdir: ".length);
      expect(yield* workspaceText(database, `${administration}/gitdir`)).toBe(
        `${worktree?.checkoutPath}/.git\n`,
      );
    });
  });
});

describe("workflow composition retention across the run", () => {
  it("keeps every record and path after the document completes", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote({
      commits: [{ message: "first", entries: [{ path: "which.txt", content: "first\n" }] }],
    });

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runDocument(
        database,
        [
          `<Repository name="project" url="${remote.locator}">`,
          `<Worktree name="implementation" branch="feature/new" as="worktree" />`,
          "</Repository>",
        ].join("\n"),
      );

      // The document finished and every live materialization is gone. What the
      // run holds is what it retained, and no deletion happened on the way out.
      const [repository] = yield* retainedRepositories(database);
      const [worktree] = yield* retainedWorktrees(database, "project");
      expect(repository?.record.name).toBe("project");
      expect(worktree?.name).toBe("implementation");
      expect(yield* workspaceText(database, `${repository?.record.checkoutPath}/which.txt`)).toBe(
        "first\n",
      );
      expect(yield* workspaceText(database, `${worktree?.checkoutPath}/which.txt`)).toBe("first\n");
    });
  });
});

describe("git fixture", () => {
  it("builds a bare remote a clone can read", function* () {
    const remote = yield* useBareRemote({
      commits: [{ message: "first", entries: [{ path: "which.txt", content: "first\n" }] }],
    });
    expect(git(["rev-parse", "HEAD"], remote.locator, remote.locator)).toBe(
      remote.heads.get("main"),
    );
  });
});

describe("workflow Repository locator admission", () => {
  it("refuses a query- or fragment-bearing url and retains nothing", function* () {
    const root = yield* useStorageRoot();

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();

      // Two places a token is ordinarily written into a URL. Neither carries
      // any part of a repository's location for the transports this provider
      // admits, and a locator is retained whole — so admitting one would be
      // deciding to keep whatever it held.
      //
      // The values here are deliberately unremarkable: a realistic secret never
      // reaches this provider at all, because the guard refuses to journal a
      // document containing one. What is under test is the other route in,
      // where the string arrives at runtime and the row is what would keep it.
      const output = String(
        yield* runDocument(
          database,
          [
            // An authored region, so both refusals are reached: without one the
            // first would fail the run and the second would never be attempted.
            "<PrintErrors>",
            '<Repository name="query" url="https://example.test/repo.git?access_token=abc" />',
            '<Repository name="fragment" url="https://example.test/repo.git#token=abc" />',
            "</PrintErrors>",
          ].join("\n"),
          countingOptions(counting),
        ),
      );

      // Refused as a locator this provider will not use, before Git is reached.
      expect(output.match(/could not be used as a Git locator/g)).toHaveLength(2);
      expect(subcommands(counting.counters)).not.toContain("clone");

      // And nothing was written: no row, so nothing retained either part.
      expect(yield* retainedRepositories(database)).toHaveLength(0);
    });
  });
});
