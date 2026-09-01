/**
 * Tier ORC — the repository vocabulary under an ordinary `xmd run`.
 *
 * The claims here are about a filesystem rather than a database. There is no
 * WorkflowRun, no Workspace, no journal and nothing to replay: what makes a
 * checkout this execution's is an advisory lock, and what makes it the same
 * checkout tomorrow is the sidecar beside it.
 *
 * Every repository in this file is real, every Git command is real, and the
 * managed root is a temporary directory of the suite's own — no test ever
 * touches the user's `~/.xmd/repositories`.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, type Operation } from "effection";
import { ensureDir, exists, readTextFile, readdir, rm, writeTextFile } from "@effectionx/fs";
import { chmod } from "node:fs/promises";
import { until } from "effection";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { GitOperationAuthorityError } from "../src/composition/errors.ts";
import { admitLivePushEvidence } from "../src/deno/run-composition/operations.ts";
import { GitComposition } from "../src/composition/git-api.ts";
import type { GitPushOutcome } from "../src/composition/git-push-records.ts";
import {
  ManagedCheckoutError,
  NoAmbientRepositoryError,
  LivePushEvidenceError,
  UnresolvedGitIdentityError,
} from "../src/deno/run-composition/errors.ts";
import { git, remoteBranch, remoteRefs, useBareRemote } from "./support/git-remotes.ts";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn, withResolvers } from "effection";
import { registerComponents } from "@executablemd/core";
import type { ChildOutcome } from "./support/run-composition-child.ts";
import { selectedRepository } from "../src/composition/context.ts";
import type { RepositorySelection } from "../src/composition/selection.ts";
import { gitHubSource } from "../src/deno/composition/github.ts";
import {
  creations,
  fakeGitHubAccess,
  gitHubStore,
  issueCreations,
  patches,
} from "./support/github.ts";
import {
  causedBy,
  commonDirectoryOf,
  countingOrdinaryHost,
  fingerprintTree,
  gitStateOf,
  haltAtGate,
  statedIdentity,
  subcommands,
  raised,
  readSidecar,
  repositorySlotOf,
  runOrdinaryDocument,
  gateComponent,
  recordingAccess,
  rewritingHost,
  useHostCheckout,
  useManagedRoot,
  useNamedOriginCheckout,
  useOriginlessCheckout,
  worktreeSlotOf,
  type HostCheckout,
} from "./support/run-composition.ts";

/** The github.com repository the modeled store answers for. */
const GITHUB_LOCATOR = "https://github.com/octo/project";

/** The head every modeled pull request in this file is opened from. */
const HEAD = "a".repeat(40);

/**
 * The routes one modeled pull request answers a reviews read on.
 *
 * The pull request itself is one of them: an answer is authenticated against
 * the subject it claims, so a collection with no pull request behind it is
 * refused rather than bound.
 */
function reviewRoutes(endpoint: string): Record<string, string> {
  return {
    "/repos/octo/project/pulls/4": JSON.stringify({
      number: 4,
      head: { sha: HEAD },
      base: { repo: { full_name: "octo/project" } },
    }),
    "/repos/octo/project/pulls/4/reviews": JSON.stringify([
      {
        id: 10,
        user: { login: "reviewer" },
        state: "APPROVED",
        body: "looks right",
        submitted_at: "2026-01-01T00:00:00Z",
        commit_id: HEAD,
        html_url: "https://github.test/pr/4#r10",
        pull_request_url: `${endpoint}/repos/octo/project/pulls/4`,
      },
    ]),
  };
}

/** Every route the three collections are read from, each answering its own. */
function evidenceRoutes(endpoint: string): Record<string, string> {
  const subject = `${endpoint}/repos/octo/project/pulls/4`;
  return {
    ...reviewRoutes(endpoint),
    "/repos/octo/project/issues/4/comments": JSON.stringify([
      {
        id: 20,
        user: { login: "watcher" },
        body: "a conversation comment",
        created_at: "2026-01-01T01:00:00Z",
        updated_at: "2026-01-01T01:00:00Z",
        html_url: "https://github.test/pr/4#c20",
        issue_url: `${endpoint}/repos/octo/project/issues/4`,
      },
    ]),
    "/repos/octo/project/pulls/4/comments": JSON.stringify([
      {
        id: 21,
        pull_request_review_id: 10,
        user: { login: "reviewer" },
        body: "an inline comment",
        created_at: "2026-01-01T02:00:00Z",
        updated_at: "2026-01-01T02:00:00Z",
        html_url: "https://github.test/pr/4#d21",
        path: "packages/core/mod.ts",
        diff_hunk: "@@ -1 +1 @@\n-old\n+new",
        commit_id: HEAD,
        original_commit_id: HEAD,
        line: 12,
        side: "RIGHT",
        start_line: null,
        start_side: null,
        in_reply_to_id: null,
        pull_request_url: subject,
      },
    ]),
    [`/repos/octo/project/commits/${HEAD}/check-runs`]: JSON.stringify({
      total_count: 1,
      check_runs: [
        {
          id: 30,
          head_sha: HEAD,
          name: "test-deno",
          status: "completed",
          conclusion: "failure",
          html_url: "https://github.test/run/30",
          started_at: "2026-01-01T03:00:00Z",
          completed_at: "2026-01-01T03:10:00Z",
          output: { title: "1 failed", summary: "a summary", text: null },
        },
      ],
    }),
    [`/repos/octo/project/commits/${HEAD}/status`]: JSON.stringify({
      sha: HEAD,
      statuses: [
        {
          id: 31,
          context: "deploy",
          state: "error",
          description: "a description",
          target_url: null,
          created_at: "2026-01-01T04:00:00Z",
          updated_at: "2026-01-01T04:00:00Z",
        },
      ],
    }),
  };
}

/** The second process every exclusive-ownership case runs. */
const CHILD = fileURLToPath(new URL("./support/run-composition-child.ts", import.meta.url));
const TOKEN = "test-token";

const REMOTE = {
  commits: [
    { message: "first", entries: [{ path: "which.txt", content: "main\n" }] },
    {
      message: "release",
      branch: "release",
      entries: [{ path: "which.txt", content: "release\n" }],
    },
  ],
} as const;

function isManagedRefusal(value: unknown): value is ManagedCheckoutError {
  return value instanceof ManagedCheckoutError;
}

function isAuthorityFailure(value: unknown): value is GitOperationAuthorityError {
  return value instanceof GitOperationAuthorityError;
}

function isMissingAmbient(value: unknown): value is NoAmbientRepositoryError {
  return value instanceof NoAmbientRepositoryError;
}

/** Every entry a slot holds, sorted, so a byte-level comparison is stable. */
function* entriesOf(path: string): Operation<string[]> {
  if (!(yield* exists(path))) {
    return [];
  }
  return [...(yield* readdir(path))].sort();
}

describe("ORC3 — the ambient primary checkout", () => {
  it("switches, stages and commits in the repository the command was run in", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    yield* runOrdinaryDocument(
      [
        `<Git.Switch branch="feature" />`,
        `<File path="notes.md">ordinary</File>`,
        `<Git.Add paths="notes.md" />`,
        `<Git.Commit message="Write notes" as="commit" />`,
      ].join("\n"),
      { root, cwd: checkout.root },
    );

    // The person's own checkout moved, and it is what a later `git` sees.
    expect(checkout.run("rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
    expect(checkout.run("log", "-1", "--pretty=%s")).toBe("Write notes");
    expect(checkout.run("show", "--pretty=", "--name-only", "HEAD")).toContain("notes.md");
  });

  it("refuses every root element that needs a repository outside a Git checkout", function* () {
    const root = yield* useManagedRoot();
    // A directory that is not inside any Git checkout.
    const elsewhere = yield* useManagedRoot();

    const outside = [
      `<Worktree name="w" branch="b" as="w" />`,
      `<Git.Switch branch="b" />`,
      `<Git.Add paths="a.md" />`,
      `<Git.Commit message="m" as="c" />`,
      `<Git.Push />`,
      `<PullRequest title="t" as="pr" />`,
    ];
    for (const source of outside) {
      const counting = countingOrdinaryHost();
      const failure = yield* raised(
        runOrdinaryDocument(source, {
          root,
          cwd: elsewhere,
          host: counting.host,
        }),
      );
      const refusal = causedBy(failure, isMissingAmbient);
      // The element travels in the message, so a failure says which of the six
      // reported something else.
      expect(`${source} ${refusal?.name}`).toBe(`${source} NoAmbientRepositoryError`);
      expect(String(refusal)).toContain("Run xmd from inside one");
      // Discovery asked Git where it was and stopped. Nothing published, nothing
      // authenticated, no transport.
      expect(counting.counters.sessions).toEqual([]);
      expect(subcommands(counting.counters)).not.toContain("push");
      expect(subcommands(counting.counters)).not.toContain("ls-remote");
    }
  });
});

describe("ORC4 — the ambient linked worktree", () => {
  it("follows the common directory for identity and the worktree root for work", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const primary = yield* useHostCheckout(remote.locator);
    // A linked worktree made by hand, exactly as a person would.
    const linked = `${primary.root}-linked`;
    primary.run("worktree", "add", "-b", "sidecar", linked);

    const before = primary.run("rev-parse", "HEAD");

    yield* scoped(function* () {
      yield* runOrdinaryDocument(
        [
          `<File path="from-worktree.md">here</File>`,
          `<Git.Add paths="from-worktree.md" />`,
          `<Git.Commit message="In the worktree" as="commit" />`,
        ].join("\n"),
        // The command is run *in the linked worktree*.
        { root, cwd: linked },
      );
    });

    // The worktree advanced; the primary checkout did not.
    expect(primary.run("rev-parse", "HEAD")).toBe(before);
    expect(primary.run("log", "-1", "--pretty=%s", "sidecar")).toBe("In the worktree");
  });
});

describe("ORC5 — origin is not local authority", () => {
  it("does local work with no origin, and refuses to publish before reaching anything", function* () {
    const root = yield* useManagedRoot();
    const solo = yield* useOriginlessCheckout();

    // Worktree, Switch, Add and Commit all work without an origin: none of them
    // has anywhere to go.
    const bound = yield* runOrdinaryDocument(
      [
        `<Worktree name="feature" branch="feature" as="worktree" />`,
        "<Dir path={worktree}>",
        `<Git.Switch branch="feature-two" />`,
        `<File path="local.md">no remote</File>`,
        `<Git.Add paths="local.md" />`,
        `<Git.Commit message="Local only" as="commit" />`,
        "</Dir>",
      ].join("\n"),
      { root, cwd: solo.root },
    );
    expect(typeof bound).toBe("string");
    expect(solo.run("log", "-1", "--pretty=%s", "feature-two")).toBe("Local only");

    // Push and PullRequest each refuse, and each refuses before a credential is
    // read, a session is opened or a byte leaves for a Git host.
    for (const source of [`<Git.Push />`, `<PullRequest title="t" as="pr" />`]) {
      const counting = countingOrdinaryHost();
      const github = recordingAccess({});
      const failure = yield* raised(
        runOrdinaryDocument(source, {
          root,
          cwd: solo.root,
          host: counting.host,
          gitHubPullRequests: { access: gitHubSource(github.access) },
          gitHubIssues: { ceiling: [GITHUB_LOCATOR], access: gitHubSource(github.access) },
        }),
      );
      expect(`${source} ${String(failure)}`).toContain("no usable origin");
      // No authentication session was opened for any locator.
      expect(counting.counters.sessions).toEqual([]);
      // No transport ran: neither observation nor publication.
      expect(subcommands(counting.counters)).not.toContain("ls-remote");
      expect(subcommands(counting.counters)).not.toContain("push");
      // And nothing was asked of a Git host — no credential, no request.
      expect(github.credentials).toBe(0);
      expect(github.requests).toEqual([]);
    }
  });

  it("opens a session and transports when there is an origin, so the counters can fail", function* () {
    // The same counters, on a repository that *does* have an origin. Without
    // this, every assertion above would pass on a counter that can never be
    // incremented — which is the one way "nothing was reached" lies.
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const counting = countingOrdinaryHost();

    yield* runOrdinaryDocument(
      [`<Git.Switch branch="published" />`, `<Git.Push />`].join("\n"),
      { root, cwd: checkout.root, host: counting.host },
    );

    expect(counting.counters.sessions).toEqual([remote.locator]);
    expect(subcommands(counting.counters)).toContain("ls-remote");
    expect(subcommands(counting.counters)).toContain("push");
  });

  it("reaches a Git host when one is configured, so those counters can fail too", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const endpoint = "https://api.github.test";
    const github = recordingAccess(reviewRoutes(endpoint), endpoint);

    yield* runOrdinaryDocument(
      `<PullRequest.Reviews url="${GITHUB_LOCATOR}/pull/4" as="reviews" />`,
      {
        root,
        cwd: checkout.root,
        gitHubPullRequests: { allowed: [GITHUB_LOCATOR], access: gitHubSource(github.access) },
      },
    );

    expect(github.credentials).toBeGreaterThan(0);
    expect(github.requests.length).toBeGreaterThan(0);
  });
});

describe("ORC6 — lexical working directories", () => {
  it("restores the enclosing directory after a Worktree body and a Dir body", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    // A relative `<File>` path resolves against the contextual working
    // directory, so where each one lands is where the document was standing.
    const common = commonDirectoryOf(checkout);
    yield* runOrdinaryDocument(
      [
        `<File path="outer.md">outer</File>`,
        `<Worktree name="inner" branch="inner" as="worktree" />`,
        `<Worktree name="lexical" branch="lexical">`,
        `<File path="within.md">within</File>`,
        "</Worktree>",
        "<Dir path={worktree}>",
        `<File path="bound.md">bound</File>`,
        "</Dir>",
        `<File path="after.md">after</File>`,
      ].join("\n"),
      { root, cwd: checkout.root },
    );

    const lexical = worktreeSlotOf(root, common, "lexical");
    const bound = worktreeSlotOf(root, common, "inner");
    expect(yield* exists(`${checkout.root}/outer.md`)).toBe(true);
    // Each body observed its own checkout.
    expect(yield* exists(`${lexical.checkout}/within.md`)).toBe(true);
    expect(yield* exists(`${bound.checkout}/bound.md`)).toBe(true);
    // Restored: the sibling after both is back in the enclosing directory.
    expect(yield* exists(`${checkout.root}/after.md`)).toBe(true);
    expect(yield* exists(`${lexical.checkout}/after.md`)).toBe(false);
    expect(yield* exists(`${bound.checkout}/after.md`)).toBe(false);
  });

  it("restores the enclosing directory when the body fails", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    // The refusal is printed rather than fatal, so the document goes on — and
    // what it goes on in is the directory the Worktree body was installed over.
    yield* runOrdinaryDocument(
      [
        "<PrintErrors>",
        `<Worktree name="failing" branch="failing">`,
        `<Git.Add paths="absent-on-purpose.md" />`,
        "</Worktree>",
        "</PrintErrors>",
        `<File path="after.md">after</File>`,
      ].join("\n"),
      { root, cwd: checkout.root },
    );
    expect(yield* exists(`${checkout.root}/after.md`)).toBe(true);
    const failing = worktreeSlotOf(root, commonDirectoryOf(checkout), "failing");
    expect(yield* exists(`${failing.checkout}/after.md`)).toBe(false);
  });

  it("restores the enclosing directory when the body is cancelled", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = worktreeSlotOf(root, commonDirectoryOf(checkout), "halted");

    // The document is torn down from outside with `<Gate />` still in flight,
    // inside the Worktree body. The installation lives on the invocation's own
    // scope, so unwinding it is what restores the enclosing directory.
    yield* haltAtGate(
      [
        `<Worktree name="halted" branch="halted">`,
        `<File path="written.md">written before the halt</File>`,
        "<Gate />",
        "</Worktree>",
      ].join("\n"),
      { root, cwd: checkout.root },
    );

    // The Worktree's own file is where the body was standing, and the enclosing
    // checkout never received it.
    expect(yield* exists(`${slot.checkout}/written.md`)).toBe(true);
    expect(yield* exists(`${checkout.root}/written.md`)).toBe(false);

    // And the enclosing directory is usable again: a later execution writes at
    // the ambient checkout, not inside the Worktree.
    yield* runOrdinaryDocument(`<File path="after.md">after</File>`, {
      root,
      cwd: checkout.root,
    });
    expect(yield* exists(`${checkout.root}/after.md`)).toBe(true);
    expect(yield* exists(`${slot.checkout}/after.md`)).toBe(false);
  });
});

describe("ORC8 — managed checkouts are persistent", () => {
  it("leaves the checkout, its metadata and its working files after the run", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const common = commonDirectoryOf(checkout);
    const slot = worktreeSlotOf(root, common, "kept");

    yield* runOrdinaryDocument(
      [
        `<Worktree name="kept" branch="kept">`,
        `<File path="draft.md">unfinished</File>`,
        "</Worktree>",
      ].join("\n"),
      { root, cwd: checkout.root },
    );

    expect(yield* exists(slot.checkout)).toBe(true);
    expect(yield* exists(`${slot.checkout}/draft.md`)).toBe(true);
    const sidecar = yield* readSidecar(slot);
    expect(sidecar).toMatchObject({
      kind: "worktree",
      version: 1,
      name: "kept",
      requestedBranch: "kept",
      requestedBase: null,
      owner: common,
    });
  });

  it("leaves a managed Repository, its metadata and its files after the run", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = repositorySlotOf(root, remote.locator, "project");

    yield* runOrdinaryDocument(
      [
        `<Repository name="project" url="${remote.locator}">`,
        `<File path="draft.md">unfinished</File>`,
        "</Repository>",
      ].join("\n"),
      { root, cwd: checkout.root },
    );

    expect(yield* exists(`${slot.checkout}/draft.md`)).toBe(true);
    expect(yield* readSidecar(slot)).toMatchObject({
      kind: "repository",
      version: 1,
      name: "project",
      locator: remote.locator,
      requestedBase: null,
    });
  });

  it("issues no Git or delete command for a checkout while tearing down", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const counting = countingOrdinaryHost();

    yield* runOrdinaryDocument(
      [
        `<Repository name="project" url="${remote.locator}" as="r" />`,
        `<Worktree name="kept" branch="kept" as="w" />`,
      ].join("\n"),
      { root, cwd: checkout.root, host: counting.host },
    );

    // Nothing that could undo a checkout ever ran — not while the document was
    // expanding, and not on the way out.
    const issued = subcommands(counting.counters);
    for (const undoing of ["reset", "clean", "restore", "prune", "gc", "fetch"]) {
      expect(`${undoing} ${issued.includes(undoing)}`).toBe(`${undoing} false`);
    }
    expect(counting.counters.commands.some((args) => args.includes("--force"))).toBe(false);
    expect(
      counting.counters.commands.some((args) => args[0] === "worktree" && args[1] === "remove"),
    ).toBe(false);
  });

  it("keeps both kinds of checkout after a cancellation", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const repository = repositorySlotOf(root, remote.locator, "project");
    const worktree = worktreeSlotOf(root, commonDirectoryOf(checkout), "surviving");

    yield* haltAtGate(
      [
        `<Repository name="project" url="${remote.locator}" as="r" />`,
        `<Worktree name="surviving" branch="surviving">`,
        `<File path="in-flight.md">written before the halt</File>`,
        "<Gate />",
        "</Worktree>",
      ].join("\n"),
      { root, cwd: checkout.root },
    );

    for (const slot of [repository, worktree]) {
      expect(yield* exists(slot.checkout)).toBe(true);
      expect(yield* readSidecar(slot)).not.toBe(undefined);
    }
    expect(yield* exists(`${worktree.checkout}/in-flight.md`)).toBe(true);
  });

  it("keeps a managed Repository after an authored failure inside its body", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = repositorySlotOf(root, remote.locator, "surviving");

    yield* raised(
      runOrdinaryDocument(
        [
          `<Repository name="surviving" url="${remote.locator}">`,
          `<File path="kept.md">written before the failure</File>`,
          `<Git.Switch branch="in-progress" />`,
          `<Git.Add paths="kept.md" />`,
          `<Git.Add paths="absent-on-purpose.md" />`,
          "</Repository>",
        ].join("\n"),
        { root, cwd: checkout.root },
      ),
    );

    // The path, the sidecar, the Git state and the working file all survive.
    expect(yield* exists(slot.checkout)).toBe(true);
    expect(yield* readSidecar(slot)).toMatchObject({
      kind: "repository",
      version: 1,
      name: "surviving",
      locator: remote.locator,
    });
    expect(yield* readTextFile(`${slot.checkout}/kept.md`)).toBe("written before the failure");
    // The branch the document switched to and the staging it did are both still
    // there: nothing rolled back, and nothing was cleaned up on the way out.
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], slot.checkout, checkout.home)).toBe(
      "in-progress",
    );
    expect(git(["diff", "--cached", "--name-only"], slot.checkout, checkout.home)).toContain(
      "kept.md",
    );
  });

  it("keeps the checkout after an authored failure inside the Worktree body", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = worktreeSlotOf(root, commonDirectoryOf(checkout), "survivor");

    yield* raised(
      runOrdinaryDocument(
        [
          `<Worktree name="survivor" branch="survivor">`,
          `<File path="kept.md">written before the failure</File>`,
          `<Git.Add paths="absent-on-purpose.md" />`,
          "</Worktree>",
        ].join("\n"),
        { root, cwd: checkout.root },
      ),
    );

    expect(yield* exists(`${slot.checkout}/kept.md`)).toBe(true);
    expect(yield* readSidecar(slot)).toMatchObject({ kind: "worktree" });
  });
});

describe("ORC9 — compatible reuse", () => {
  it("reuses the same checkout and preserves the work the first run left", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = repositorySlotOf(root, remote.locator, "project");

    const document = `<Repository name="project" url="${remote.locator}" as="repository" />`;

    const first = yield* runOrdinaryDocument(document, { root, cwd: checkout.root });
    const created = yield* readSidecar(slot);

    // Work a person would do between two runs: a new branch and a commit.
    git(["switch", "-c", "later"], slot.checkout, checkout.home);
    git(["commit", "--allow-empty", "-m", "moved on"], slot.checkout, checkout.home);
    const moved = git(["rev-parse", "HEAD"], slot.checkout, checkout.home);

    // And uncommitted work: one tracked file edited, one untracked file added.
    yield* writeTextFile(`${slot.checkout}/which.txt`, "edited by hand\n");
    yield* writeTextFile(`${slot.checkout}/scratch.md`, "not committed\n");
    const dirty = git(["status", "--porcelain"], slot.checkout, checkout.home);
    expect(dirty).toContain("which.txt");
    expect(dirty).toContain("scratch.md");

    const second = yield* runOrdinaryDocument(document, { root, cwd: checkout.root });

    expect(second).toBe(first);
    // Reuse revalidated the identity — owner, origin, object format and creation
    // commit — and recorded nothing new.
    expect(yield* readSidecar(slot)).toEqual(created);
    // Neither the branch it is on nor the commit it holds was reset.
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], slot.checkout, checkout.home)).toBe("later");
    expect(git(["rev-parse", "HEAD"], slot.checkout, checkout.home)).toBe(moved);
    // And the working tree is exactly as dirty as it was left.
    expect(git(["status", "--porcelain"], slot.checkout, checkout.home)).toBe(dirty);
    expect(yield* readTextFile(`${slot.checkout}/which.txt`)).toBe("edited by hand\n");
    expect(yield* readTextFile(`${slot.checkout}/scratch.md`)).toBe("not committed\n");
  });

  it("revalidates the identity it reuses rather than trusting the sidecar", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = repositorySlotOf(root, remote.locator, "project");
    const document = `<Repository name="project" url="${remote.locator}" as="r" />`;

    yield* runOrdinaryDocument(document, { root, cwd: checkout.root });
    const counting = countingOrdinaryHost();
    yield* runOrdinaryDocument(document, {
      root,
      cwd: checkout.root,
      host: counting.host,
    });

    // The second selection asked the checkout itself who it is, rather than
    // reading the sidecar and believing it.
    const issued = counting.counters.commands.map((args) => args.join(" "));
    expect(issued.some((command) => command.includes("rev-parse --show-toplevel"))).toBe(true);
    expect(issued.some((command) => command.includes("rev-parse --git-common-dir"))).toBe(true);
    expect(issued.some((command) => command.includes("rev-parse --show-object-format"))).toBe(true);
    expect(issued.some((command) => command.includes("config --get remote.origin.url"))).toBe(true);
    // And it cloned nothing.
    expect(subcommands(counting.counters)).not.toContain("clone");
  });
});

describe("ORC10 — a conflict changes nothing", () => {
  /**
   * One refusal, fingerprinted on both sides.
   *
   * The claim is not "it failed" but "it failed and changed nothing", so the
   * slot's complete byte fingerprint and the checkout's own Git state are taken
   * before the refusal and compared after it. A reset, a fetch, a switch or a
   * rewritten sidecar would all show up here.
   */
  function* refusesWithoutMutating(
    slot: ReturnType<typeof repositorySlotOf>,
    checkout: HostCheckout,
    run: () => Operation<unknown>,
    reason: string,
  ): Operation<void> {
    const bytes = yield* fingerprintTree(slot.slot);
    const state = gitStateOf(checkout, slot.checkout);

    const failure = yield* raised(run());
    expect(`${reason}: ${causedBy(failure, isManagedRefusal)?.reason}`).toBe(
      `${reason}: incompatible-reuse`,
    );

    expect(yield* fingerprintTree(slot.slot)).toEqual(bytes);
    expect(gitStateOf(checkout, slot.checkout)).toEqual(state);
  }

  it("refuses every changed Repository fact and leaves the slot byte-identical", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const other = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = repositorySlotOf(root, remote.locator, "project");
    const document = `<Repository name="project" url="${remote.locator}" as="r" />`;

    yield* runOrdinaryDocument(document, { root, cwd: checkout.root });
    const created = yield* readSidecar(slot);

    // A changed base. Same name, same url, different creation identity.
    yield* refusesWithoutMutating(
      slot,
      checkout,
      () =>
        runOrdinaryDocument(
          `<Repository name="project" url="${remote.locator}" base="release" as="r" />`,
          { root, cwd: checkout.root },
        ),
      "changed base",
    );

    // A sidecar somebody edited. The object format is the member the checkout
    // itself can contradict, so this is the object-format comparison too.
    yield* writeTextFile(
      slot.metadata,
      `${JSON.stringify({ ...(created as object), objectFormat: "sha256" }, null, 2)}\n`,
    );
    yield* refusesWithoutMutating(
      slot,
      checkout,
      () => runOrdinaryDocument(document, { root, cwd: checkout.root }),
      "object format",
    );

    // A sidecar naming another repository's creation commit.
    yield* writeTextFile(
      slot.metadata,
      `${JSON.stringify({ ...(created as object), creationCommit: "0".repeat(40) }, null, 2)}\n`,
    );
    yield* refusesWithoutMutating(
      slot,
      checkout,
      () => runOrdinaryDocument(document, { root, cwd: checkout.root }),
      "metadata",
    );

    // An origin that no longer names what the checkout was cloned from.
    yield* writeTextFile(slot.metadata, `${JSON.stringify(created, null, 2)}\n`);
    git(["remote", "set-url", "origin", other.locator], slot.checkout, checkout.home);
    yield* refusesWithoutMutating(
      slot,
      checkout,
      () => runOrdinaryDocument(document, { root, cwd: checkout.root }),
      "origin",
    );
    git(["remote", "set-url", "origin", remote.locator], slot.checkout, checkout.home);

    // A common directory belonging to a different repository: the slot now
    // holds an unrelated clone at exactly the recorded path.
    const shadow = `${slot.slot}/shadow`;
    git(["clone", "--", other.locator, shadow], slot.slot, checkout.home);
    yield* rm(slot.checkout, { recursive: true });
    git(["clone", "--", other.locator, slot.checkout], slot.slot, checkout.home);
    yield* refusesWithoutMutating(
      slot,
      checkout,
      () => runOrdinaryDocument(document, { root, cwd: checkout.root }),
      "common directory",
    );
  });

  it("refuses a Worktree asked for on a different branch or base, and changes nothing", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = worktreeSlotOf(root, commonDirectoryOf(checkout), "review");

    yield* runOrdinaryDocument(`<Worktree name="review" branch="one" as="w" />`, {
      root,
      cwd: checkout.root,
    });
    const created = yield* readSidecar(slot);

    for (const [reason, source] of [
      ["branch", `<Worktree name="review" branch="two" as="w" />`],
      ["base", `<Worktree name="review" branch="one" base="release" as="w" />`],
    ] as const) {
      const bytes = yield* fingerprintTree(slot.slot);
      const state = gitStateOf(checkout, slot.checkout);
      const failure = yield* raised(runOrdinaryDocument(source, { root, cwd: checkout.root }));
      expect(`${reason}: ${causedBy(failure, isManagedRefusal)?.reason}`).toBe(
        `${reason}: incompatible-reuse`,
      );
      expect(yield* fingerprintTree(slot.slot)).toEqual(bytes);
      expect(gitStateOf(checkout, slot.checkout)).toEqual(state);
      expect(yield* readSidecar(slot)).toEqual(created);
    }
  });

  it("refuses a Worktree whose checkout stopped belonging to its owner", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const other = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const common = commonDirectoryOf(checkout);
    const slot = worktreeSlotOf(root, common, "owned");

    yield* runOrdinaryDocument(`<Worktree name="owned" branch="owned" as="w" />`, {
      root,
      cwd: checkout.root,
    });

    // An unrelated clone at exactly the recorded path. It is a perfectly good
    // Git checkout; what it is not is a linked worktree of the owner.
    yield* rm(slot.checkout, { recursive: true });
    git(["clone", "--", other.locator, slot.checkout], slot.slot, checkout.home);

    const bytes = yield* fingerprintTree(slot.slot);
    const failure = yield* raised(
      runOrdinaryDocument(`<Worktree name="owned" branch="owned" as="w" />`, {
        root,
        cwd: checkout.root,
      }),
    );
    expect(causedBy(failure, isManagedRefusal)?.reason).toBe("incompatible-reuse");
    expect(String(failure)).toContain("linked checkout");
    expect(yield* fingerprintTree(slot.slot)).toEqual(bytes);
  });
});

describe("ORC11 — an interrupted creation", () => {
  it("adopts a metadata-free checkout that is exactly what creation would have left", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = repositorySlotOf(root, remote.locator, "project");

    const document = `<Repository name="project" url="${remote.locator}" as="r" />`;
    yield* runOrdinaryDocument(document, { root, cwd: checkout.root });
    const written = yield* readSidecar(slot);
    // Exactly the state an interruption between the clone and the sidecar
    // leaves: the checkout, and nothing describing it.
    yield* rm(slot.metadata);
    expect(yield* readSidecar(slot)).toBe(undefined);

    yield* runOrdinaryDocument(document, { root, cwd: checkout.root });
    expect(yield* readSidecar(slot)).toEqual(written);
  });

  it("refuses a slot holding something creation would never have left", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = repositorySlotOf(root, remote.locator, "project");

    const document = `<Repository name="project" url="${remote.locator}" as="r" />`;
    yield* runOrdinaryDocument(document, { root, cwd: checkout.root });
    yield* rm(slot.metadata);
    // An unexplained entry beside the checkout.
    yield* writeTextFile(`${slot.slot}/stray.txt`, "who put this here\n");
    const beforeEntries = yield* entriesOf(slot.slot);

    const failure = yield* raised(runOrdinaryDocument(document, { root, cwd: checkout.root }));
    expect(causedBy(failure, isManagedRefusal)?.reason).toBe("partial-creation");
    expect(yield* entriesOf(slot.slot)).toEqual(beforeEntries);
    expect(yield* readSidecar(slot)).toBe(undefined);
  });

  it("adopts a metadata-free Worktree that is exactly what creation would have left", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = worktreeSlotOf(root, commonDirectoryOf(checkout), "resumed");
    const document = `<Worktree name="resumed" branch="resumed" as="w" />`;

    yield* runOrdinaryDocument(document, { root, cwd: checkout.root });
    const written = yield* readSidecar(slot);
    yield* rm(slot.metadata);

    yield* runOrdinaryDocument(document, { root, cwd: checkout.root });
    expect(yield* readSidecar(slot)).toEqual(written);
  });

  it("refuses a metadata-free Worktree that creation would never have left", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = worktreeSlotOf(root, commonDirectoryOf(checkout), "moved");
    const document = `<Worktree name="moved" branch="moved" as="w" />`;

    yield* runOrdinaryDocument(document, { root, cwd: checkout.root });
    yield* rm(slot.metadata);
    // The branch it is on is no longer the branch this request names, so this
    // is not the state creation would have left behind.
    git(["switch", "-c", "somewhere-else"], slot.checkout, checkout.home);

    const bytes = yield* fingerprintTree(slot.slot);
    const failure = yield* raised(runOrdinaryDocument(document, { root, cwd: checkout.root }));
    expect(causedBy(failure, isManagedRefusal)?.reason).toBe("partial-creation");
    expect(yield* fingerprintTree(slot.slot)).toEqual(bytes);
    expect(yield* readSidecar(slot)).toBe(undefined);
  });
});

describe("ORC13 — live local Git", () => {
  it("makes real, non-transactional changes and claims no rollback on failure", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    const failure = yield* raised(
      runOrdinaryDocument(
        [
          `<Git.Switch branch="partway" />`,
          `<File path="staged.md">staged before the failure</File>`,
          `<Git.Add paths="staged.md" />`,
          `<Git.Add paths="never-existed.md" />`,
        ].join("\n"),
        { root, cwd: checkout.root },
      ),
    );
    expect(failure).toBeInstanceOf(Error);

    // The switch and the first Add really happened, and nothing took them back.
    expect(checkout.run("rev-parse", "--abbrev-ref", "HEAD")).toBe("partway");
    expect(checkout.run("diff", "--cached", "--name-only")).toContain("staged.md");
  });

  it("keeps what a cancelled document had already done, and claims no rollback", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    yield* haltAtGate(
      [
        `<Git.Switch branch="interrupted" />`,
        `<File path="staged.md">staged before the halt</File>`,
        `<Git.Add paths="staged.md" />`,
        "<Gate />",
        `<Git.Commit message="never reached" as="commit" />`,
      ].join("\n"),
      { root, cwd: checkout.root },
    );

    // Both transitions really happened, and nothing took them back.
    expect(checkout.run("rev-parse", "--abbrev-ref", "HEAD")).toBe("interrupted");
    expect(checkout.run("diff", "--cached", "--name-only")).toContain("staged.md");
    // And the commit the document never reached was never made.
    expect(checkout.run("log", "-1", "--pretty=%s")).not.toBe("never reached");
  });

  it("commits as the invoking user, not as the workflow identity", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    yield* runOrdinaryDocument(
      [
        `<File path="mine.md">mine</File>`,
        `<Git.Add paths="mine.md" />`,
        `<Git.Commit message="Authored by me" as="commit" />`,
      ].join("\n"),
      {
        root,
        cwd: checkout.root,
        identity: statedIdentity("Ada Lovelace <ada@example.test> 1 +0000"),
      },
    );

    expect(checkout.run("log", "-1", "--pretty=%an|%ae|%cn|%ce")).toBe(
      "Ada Lovelace|ada@example.test|Ada Lovelace|ada@example.test",
    );
    expect(checkout.run("log", "-1", "--pretty=%an")).not.toBe("Executable.md workflow");
  });

  it("takes author and committer separately when the host resolves them apart", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    yield* runOrdinaryDocument(
      [
        `<File path="pair.md">pair</File>`,
        `<Git.Add paths="pair.md" />`,
        `<Git.Commit message="Two identities" as="commit" />`,
      ].join("\n"),
      {
        root,
        cwd: checkout.root,
        identity: statedIdentity(
          "Ada Lovelace <ada@example.test> 1 +0000",
          "Grace Hopper <grace@example.test> 1 +0000",
        ),
      },
    );

    expect(checkout.run("log", "-1", "--pretty=%an|%ae|%cn|%ce")).toBe(
      "Ada Lovelace|ada@example.test|Grace Hopper|grace@example.test",
    );
  });

  it("refuses to commit when the host cannot say who the commit is by", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const before = checkout.run("rev-parse", "HEAD");

    const failure = yield* raised(
      runOrdinaryDocument(
        [
          `<File path="orphan.md">orphan</File>`,
          `<Git.Add paths="orphan.md" />`,
          `<Git.Commit message="Nobody" as="commit" />`,
        ].join("\n"),
        { root, cwd: checkout.root, identity: statedIdentity(undefined) },
      ),
    );

    expect(failure).toBeInstanceOf(UnresolvedGitIdentityError);
    expect(String(failure)).toContain("git config --global user.name");
    // Nothing was committed, and no identity was substituted.
    expect(checkout.run("rev-parse", "HEAD")).toBe(before);
    // The staging that came before it still happened: this refuses the commit,
    // not the document that led to it.
    expect(checkout.run("diff", "--cached", "--name-only")).toContain("orphan.md");
  });

  it("leaves every other component usable when no identity resolves", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    // Repository, Worktree, Dir, Switch and Add all work: none of them writes a
    // commit object, so none of them needs to know who anybody is.
    const rendered = yield* runOrdinaryDocument(
      [
        `<Repository name="project" url="${remote.locator}" as="repository" />`,
        `<Worktree name="usable" branch="usable" as="worktree" />`,
        "<Dir path={worktree}>",
        `<Git.Switch branch="usable-two" />`,
        `<File path="fine.md">fine</File>`,
        `<Git.Add paths="fine.md" />`,
        "</Dir>",
        "",
        "ran",
      ].join("\n"),
      { root, cwd: checkout.root, identity: statedIdentity(undefined) },
    );
    expect(String(rendered)).toContain("ran");
  });

  it("keeps hooks, monitors, signing and repository helpers disabled", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const outside = yield* useTempDirectory("xmd-ordinary-hooks-");
    const marks = { pre: `${outside}/pre-commit`, post: `${outside}/post-commit` };

    // A repository that does everything it can to run a program of its own: two
    // hooks, a signing program, a file-system monitor and a credential helper.
    for (const [hook, mark] of [
      ["pre-commit", marks.pre],
      ["post-commit", marks.post],
    ] as const) {
      yield* ensureDir(`${checkout.root}/.githooks`);
      yield* writeTextFile(
        `${checkout.root}/.githooks/${hook}`,
        `#!/bin/sh\nprintf ran > ${mark}\n`,
      );
      yield* until(chmod(`${checkout.root}/.githooks/${hook}`, 0o755));
    }
    checkout.run("config", "core.hooksPath", ".githooks");
    checkout.run("config", "commit.gpgSign", "true");
    checkout.run("config", "gpg.program", `${outside}/absent-signer`);
    checkout.run("config", "core.fsmonitor", `${outside}/absent-monitor`);
    checkout.run("config", "credential.helper", `!${outside}/absent-helper`);

    yield* runOrdinaryDocument(
      [
        `<File path="safe.md">safe</File>`,
        `<Git.Add paths="safe.md" />`,
        `<Git.Commit message="Still isolated" as="commit" />`,
      ].join("\n"),
      {
        root,
        cwd: checkout.root,
        identity: statedIdentity("Ada Lovelace <ada@example.test> 1 +0000"),
      },
    );

    // The identity is the only thing borrowed. Neither hook ran, the commit is
    // unsigned, and the monitor and helper programs — which do not exist —
    // never had to.
    expect({
      pre: yield* exists(marks.pre),
      post: yield* exists(marks.post),
    }).toEqual({ pre: false, post: false });
    expect(checkout.run("log", "-1", "--pretty=%G?")).toBe("N");
    expect(checkout.run("log", "-1", "--pretty=%an")).toBe("Ada Lovelace");
  });

  it("refuses a branch another checkout of the same repository holds", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    yield* runOrdinaryDocument(`<Worktree name="held" branch="held" as="w" />`, {
      root,
      cwd: checkout.root,
    });

    const failure = yield* raised(
      runOrdinaryDocument(`<Git.Switch branch="held" />`, { root, cwd: checkout.root }),
    );
    expect(String(failure)).toContain("branch-checked-out-elsewhere");
  });
});

describe("ORC14 — live Push evidence", () => {
  it("records a performed publication and lets exactly that head be authorized", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    const failure = yield* raised(
      runOrdinaryDocument(
        [
          `<Git.Switch branch="published" />`,
          `<File path="published.md">published</File>`,
          `<Git.Add paths="published.md" />`,
          `<Git.Commit message="Publish" as="commit" />`,
          `<Git.Push />`,
          `<PullRequest title="Publish" as="pullRequest" />`,
        ].join("\n"),
        { root, cwd: checkout.root },
      ),
    );

    // The branch really is at the remote, at the commit this execution made.
    expect(remoteBranch(remote, "published")).toBe(checkout.run("rev-parse", "HEAD"));
    // And the pull request got past the evidence gate: what stopped it is the
    // adapter declining a locator that is not a github.com repository, which is
    // the step *after* the local authorization this criterion is about.
    expect(String(failure)).toContain("only for repositories on github.com");
    expect(String(failure)).not.toContain("holds no successful <Git.Push> result");
  });

  it("records an already-equal publication the same way it records a performed one", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    // The first execution performs the publication.
    yield* runOrdinaryDocument(
      [
        `<Git.Switch branch="equal" />`,
        `<File path="equal.md">equal</File>`,
        `<Git.Add paths="equal.md" />`,
        `<Git.Commit message="Equal" as="commit" />`,
        `<Git.Push />`,
      ].join("\n"),
      { root, cwd: checkout.root },
    );
    const published = checkout.run("rev-parse", "HEAD");
    expect(remoteBranch(remote, "equal")).toBe(published);

    // The second finds the destination already naming this exact commit and
    // adopts it — pushing nothing — and the adopted publication is evidence.
    const counting = countingOrdinaryHost();
    const failure = yield* raised(
      runOrdinaryDocument(
        [`<Git.Push />`, `<PullRequest title="Equal" as="pullRequest" />`].join("\n"),
        { root, cwd: checkout.root, host: counting.host },
      ),
    );
    expect(subcommands(counting.counters)).toContain("ls-remote");
    expect(subcommands(counting.counters)).not.toContain("push");
    expect(String(failure)).toContain("only for repositories on github.com");
    expect(String(failure)).not.toContain("holds no successful <Git.Push> result");
  });

  it("refuses when the Push named another branch, checkout, origin or destination", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const other = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    // Another branch and therefore another destination ref: the Push is real
    // and irrelevant.
    const branch = yield* raised(
      runOrdinaryDocument(
        [
          `<Git.Switch branch="elsewhere" />`,
          `<Git.Push />`,
          `<Git.Switch branch="unpublished" />`,
          `<PullRequest title="Not this one" as="pullRequest" />`,
        ].join("\n"),
        { root, cwd: checkout.root },
      ),
    );
    expect(String(branch)).toContain("holds no successful <Git.Push> result");
    expect(remoteBranch(remote, "unpublished")).toBe(undefined);

    // Another repository entirely: a managed Repository publishes, and the
    // ambient one asks.
    const repository = yield* raised(
      runOrdinaryDocument(
        [
          `<Repository name="managed" url="${other.locator}">`,
          `<Git.Switch branch="managed-branch" />`,
          `<Git.Push />`,
          "</Repository>",
          `<Git.Switch branch="managed-branch" />`,
          `<PullRequest title="Wrong repository" as="pullRequest" />`,
        ].join("\n"),
        { root, cwd: checkout.root },
      ),
    );
    expect(String(repository)).toContain("holds no successful <Git.Push> result");
  });

  it("admits one head only when every dimension of the publication matches", function* () {
    const identity = {
      name: "project",
      locatorFingerprint: "a".repeat(64),
      requestedBase: null,
      creationCommit: "b".repeat(40),
      primaryBranch: "main",
      objectFormat: "sha1" as const,
    };
    const held = {
      identity,
      checkoutRoot: "/checkouts/project",
      origin: "https://github.com/octo/project",
      branch: "feature",
      destinationRef: "refs/heads/feature",
      commit: "c".repeat(40),
    };

    // The exact publication authorizes.
    admitLivePushEvidence([held], held);

    // Every single dimension, changed on its own, does not. Git forbids two
    // checkouts of one repository on one branch, so the checkout dimension is
    // unreachable through a document — and it is exactly as load-bearing as the
    // others, which is why it is asked here rather than left unasked.
    const wrong: readonly [string, typeof held][] = [
      ["repository", { ...held, identity: { ...identity, locatorFingerprint: "d".repeat(64) } }],
      ["checkout", { ...held, checkoutRoot: "/checkouts/elsewhere" }],
      ["origin", { ...held, origin: "https://github.com/octo/other" }],
      ["branch", { ...held, branch: "other" }],
      ["destination", { ...held, destinationRef: "refs/heads/other" }],
      ["commit", { ...held, commit: "e".repeat(40) }],
    ];
    for (const [dimension, expected] of wrong) {
      let refused: unknown;
      try {
        admitLivePushEvidence([held], expected);
      } catch (error) {
        refused = error;
      }
      expect(`${dimension}: ${refused instanceof LivePushEvidenceError}`).toBe(
        `${dimension}: true`,
      );
    }

    // A changed commit on the same destination is disagreement, not absence.
    let conflicting: unknown;
    try {
      admitLivePushEvidence([held], { ...held, commit: "e".repeat(40) });
    } catch (error) {
      conflicting = error;
    }
    expect((conflicting as LivePushEvidenceError).reason).toBe("conflicting-push-evidence");

    // And the last publication of a destination is the one that decides.
    const superseded = { ...held, commit: "f".repeat(40) };
    admitLivePushEvidence([held, superseded], superseded);
    let stale: unknown;
    try {
      admitLivePushEvidence([held, superseded], held);
    } catch (error) {
      stale = error;
    }
    expect((stale as LivePushEvidenceError).reason).toBe("conflicting-push-evidence");
  });

  it("lets the latest publication of a destination decide", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    // Two publications of one destination, at successive commits, and then a
    // third commit nothing published.
    const failure = yield* raised(
      runOrdinaryDocument(
        [
          `<Git.Switch branch="moving" />`,
          `<File path="one.md">one</File>`,
          `<Git.Add paths="one.md" />`,
          `<Git.Commit message="One" as="first" />`,
          `<Git.Push />`,
          `<File path="two.md">two</File>`,
          `<Git.Add paths="two.md" />`,
          `<Git.Commit message="Two" as="second" />`,
          `<Git.Push />`,
          `<File path="three.md">three</File>`,
          `<Git.Add paths="three.md" />`,
          `<Git.Commit message="Three" as="third" />`,
          `<PullRequest title="Moved on" as="pullRequest" />`,
        ].join("\n"),
        { root, cwd: checkout.root },
      ),
    );
    // The second publication superseded the first, and the head has moved past
    // both — so this is a conflict rather than an absence.
    expect(String(failure)).toContain("published that branch at a different commit");
    expect(remoteBranch(remote, "moving")).toBe(checkout.run("rev-parse", "HEAD~1"));
  });

  it("authorizes at the second publication's commit, not the first's", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    const failure = yield* raised(
      runOrdinaryDocument(
        [
          `<Git.Switch branch="latest" />`,
          `<File path="one.md">one</File>`,
          `<Git.Add paths="one.md" />`,
          `<Git.Commit message="One" as="first" />`,
          `<Git.Push />`,
          `<File path="two.md">two</File>`,
          `<Git.Add paths="two.md" />`,
          `<Git.Commit message="Two" as="second" />`,
          `<Git.Push />`,
          `<PullRequest title="Latest" as="pullRequest" />`,
        ].join("\n"),
        { root, cwd: checkout.root },
      ),
    );
    // Past the gate: the latest publication names the head the pull request
    // would open from.
    expect(String(failure)).toContain("only for repositories on github.com");
    expect(remoteBranch(remote, "latest")).toBe(checkout.run("rev-parse", "HEAD"));
  });
});

describe("ORC15 — evidence cannot cross runs", () => {
  it("refuses a PullRequest in an execution that published nothing", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    const failure = yield* raised(
      runOrdinaryDocument(`<PullRequest title="Nothing pushed" as="pr" />`, {
        root,
        cwd: checkout.root,
      }),
    );
    expect(String(failure)).toContain("holds no successful <Git.Push> result");
  });

  it("does not let one execution's real publication authorize the next", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const store = gitHubStore({ token: TOKEN });
    store.resolveHead = (branch) => remoteRefs(remote).get(`refs/heads/${branch}`);
    const root = yield* useManagedRoot();
    const checkout = yield* useNamedOriginCheckout(remote, GITHUB_LOCATOR);
    const options = {
      root,
      cwd: checkout.root,
      host: rewritingHost(GITHUB_LOCATOR, remote.locator),
      gitHubPullRequests: { access: gitHubSource(fakeGitHubAccess(store)) },
    };

    // One execution publishes and opens a pull request. This is the real thing:
    // a branch at the remote and a pull request at the modeled GitHub.
    yield* runOrdinaryDocument(
      [
        `<Git.Switch branch="crossing" />`,
        `<File path="crossing.md">crossing</File>`,
        `<Git.Add paths="crossing.md" />`,
        `<Git.Commit message="Crossing" as="commit" />`,
        `<Git.Push />`,
        `<PullRequest title="Crossing" as="pullRequest" />`,
      ].join("\n"),
      options,
    );
    expect(creations(store)).toBe(1);
    const published = checkout.run("rev-parse", "HEAD");
    expect(remoteBranch(remote, "crossing")).toBe(published);

    // A second, ordinary execution. The branch is still at the remote, the
    // checkout is still on it, and the pull request still exists — and none of
    // that is this execution's evidence.
    const second = yield* raised(
      runOrdinaryDocument(`<PullRequest title="Crossing" as="pullRequest" />`, options),
    );
    expect(String(second)).toContain("holds no successful <Git.Push> result");

    // The refusal never reached GitHub at all.
    expect(creations(store)).toBe(1);
    expect(patches(store)).toBe(0);
  });

  it("grants nothing to a Push result middleware handed back without performing one", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    // One execution really publishes, and the suite keeps the exact outcome the
    // provider answered with — the whole successful `GitPushOutcome`.
    let published: GitPushOutcome | undefined;
    yield* runOrdinaryDocument(
      [
        `<Git.Switch branch="copied" />`,
        `<File path="copied.md">copied</File>`,
        `<Git.Add paths="copied.md" />`,
        `<Git.Commit message="Copied" as="commit" />`,
        `<Git.Push />`,
        "<Capture />",
      ].join("\n"),
      {
        root,
        cwd: checkout.root,
        around: function* () {
          yield* GitComposition.around({
            *pushCurrentBranch([invocation], next): Operation<GitPushOutcome> {
              published = yield* next(invocation);
              return published;
            },
          });
        },
        components: [
          {
            name: "Capture",
            origin: "test",
            props: { type: "object", additionalProperties: false },
            // deno-lint-ignore require-yield
            *fn(): Operation<string> {
              return "";
            },
          },
        ],
      },
    );
    expect(published).toBeDefined();
    expect(published?.decision).toBe("performed");
    const head = checkout.run("rev-parse", "HEAD");

    // A new execution whose `<Git.Push>` is answered by middleware handing that
    // exact successful outcome back. The provider underneath never runs, so it
    // never verifies a publication and never records evidence — and a result is
    // not evidence.
    let delegated = 0;
    const failure = yield* raised(
      runOrdinaryDocument([`<Git.Push />`, `<PullRequest title="Copied" as="pr" />`].join("\n"), {
        root,
        cwd: checkout.root,
        around: function* () {
          yield* GitComposition.around({
            // deno-lint-ignore require-yield
            *pushCurrentBranch([_invocation], _next): Operation<GitPushOutcome> {
              delegated += 1;
              if (published === undefined) {
                throw new Error("the suite captured no publication to hand back");
              }
              return published;
            },
          });
        },
      }),
    );

    // The middleware answered, so the component saw a successful Push.
    expect(delegated).toBe(1);
    // The branch really is still published at that commit, so nothing about the
    // world contradicts the copied result.
    expect(remoteBranch(remote, "copied")).toBe(head);
    // And the pull request is refused anyway: what authorizes it is what this
    // provider verified, not what anything handed it.
    expect(String(failure)).toContain("holds no successful <Git.Push> result");
  });

  it("grants nothing to a copied selection, a copied result or a previous trace", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    // One execution publishes, and hands its own Repository selection and the
    // rendered result of the Push out to the suite.
    let carried: RepositorySelection | undefined;
    yield* runOrdinaryDocument(
      [
        `<Git.Switch branch="carried" />`,
        `<File path="carried.md">carried</File>`,
        `<Git.Add paths="carried.md" />`,
        `<Git.Commit message="Carried" as="commit" />`,
        `<Git.Push />`,
        "<Capture />",
      ].join("\n"),
      {
        root,
        cwd: checkout.root,
        components: [
          {
            name: "Capture",
            origin: "test",
            props: { type: "object", additionalProperties: false },
            *fn(): Operation<string> {
              carried = yield* selectedRepository();
              return "";
            },
          },
        ],
      },
    );
    expect(carried).toBeDefined();

    // A new execution, handed the exact selection the first one minted and the
    // path it bound, installed as its contextual Repository.
    const failure = yield* raised(
      runOrdinaryDocument(`<PullRequest title="Carried" as="pullRequest" />`, {
        root,
        cwd: checkout.root,
        contextualRepository: carried,
      }),
    );
    // The selection is not one this provider minted, so it names no checkout —
    // and the evidence it would have needed does not exist here either.
    expect(String(failure)).toContain("not one this execution selected");
  });
});

describe("ORC16 — live Issues", () => {
  it("reads and files through the configured transport, keyed to this execution", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const store = gitHubStore({
      token: TOKEN,
      issues: [
        {
          number: 7,
          nodeId: "I_7",
          state: "open",
          title: "an existing issue",
          body: "described",
          labels: [],
          assignee: null,
        },
      ],
    });
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const options = {
      root,
      cwd: checkout.root,
      gitHubIssues: {
        ceiling: [GITHUB_LOCATOR],
        access: gitHubSource(fakeGitHubAccess(store)),
      },
    };

    const rendered = yield* runOrdinaryDocument(
      [
        `<Issue url="${GITHUB_LOCATOR}/issues/7" as="found" />`,
        "",
        "read {found.title}",
        "",
        `<IssueTracker url="${GITHUB_LOCATOR}">`,
        `<Issue title="filed by an ordinary run" as="filed">`,
        "the description",
        "</Issue>",
        "</IssueTracker>",
      ].join("\n"),
      options,
    );
    expect(String(rendered)).toContain("read an existing issue");
    expect(issueCreations(store)).toBe(1);

    // A second execution is a new question, not a resumption: the identity it
    // presents is its own, so the provider is asked again.
    yield* runOrdinaryDocument(
      [
        `<IssueTracker url="${GITHUB_LOCATOR}">`,
        `<Issue title="filed by an ordinary run" as="filed">`,
        "the description",
        "</Issue>",
        "</IssueTracker>",
      ].join("\n"),
      options,
    );
    expect(issueCreations(store)).toBe(2);
  });

  it("sends no credential and no request for a target outside the ceiling", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const store = gitHubStore({ token: TOKEN });
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    const failure = yield* raised(
      runOrdinaryDocument(`<Issue url="https://github.com/other/repo/issues/1" as="found" />`, {
        root,
        cwd: checkout.root,
        gitHubIssues: {
          ceiling: [GITHUB_LOCATOR],
          access: gitHubSource(fakeGitHubAccess(store)),
        },
      }),
    );
    expect(failure).toBeInstanceOf(Error);
    expect(store.requests).toHaveLength(0);
  });

  it("installs no matching provider when nothing is configured", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    const failure = yield* raised(
      runOrdinaryDocument(`<Issue url="${GITHUB_LOCATOR}/issues/7" as="found" />`, {
        root,
        cwd: checkout.root,
      }),
    );
    expect(String(failure)).toContain("no issue provider handles");
  });
});

describe("ORC17 — live PullRequests", () => {
  it("opens a pull request the run published, through the configured transport", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const store = gitHubStore({ token: TOKEN });
    store.resolveHead = (branch) => remoteRefs(remote).get(`refs/heads/${branch}`);
    const root = yield* useManagedRoot();
    const checkout = yield* useNamedOriginCheckout(remote, GITHUB_LOCATOR);

    const rendered = yield* runOrdinaryDocument(
      [
        `<Git.Switch branch="opened" />`,
        `<File path="opened.md">opened</File>`,
        `<Git.Add paths="opened.md" />`,
        `<Git.Commit message="Opened" as="commit" />`,
        `<Git.Push />`,
        `<PullRequest title="Opened" as="pullRequest">`,
        "the body",
        "</PullRequest>",
        "",
        "number {pullRequest.number} state {pullRequest.state}",
      ].join("\n"),
      {
        root,
        cwd: checkout.root,
        host: rewritingHost(GITHUB_LOCATOR, remote.locator),
        gitHubPullRequests: { access: gitHubSource(fakeGitHubAccess(store)) },
      },
    );
    expect(creations(store)).toBe(1);
    expect(String(rendered)).toContain("state open");
    // The evidence it bound names the repository this run acted on.
    expect(String(rendered)).toContain("number 1");
  });

  it("reads all three collections, each from its own route", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const endpoint = "https://api.github.test";
    const recording = recordingAccess(evidenceRoutes(endpoint), endpoint);
    const access = gitHubSource(recording.access);

    // All three, in one document, under the ordinary provider.
    const rendered = yield* runOrdinaryDocument(
      [
        `<PullRequest.Reviews url="${GITHUB_LOCATOR}/pull/4" as="reviews" />`,
        `<PullRequest.Comments url="${GITHUB_LOCATOR}/pull/4" as="comments" />`,
        `<PullRequest.Checks url="${GITHUB_LOCATOR}/pull/4" as="checks" />`,
        "",
        "counts {reviews.length} {comments.length} {checks.length}",
        "",
        "<Json value={reviews} />",
        "",
        "<Json value={comments} />",
        "",
        "<Json value={checks} />",
      ].join("\n"),
      {
        root,
        cwd: checkout.root,
        gitHubPullRequests: { allowed: [GITHUB_LOCATOR], access },
      },
    );

    // One review, two comments of both kinds, and two checks of both kinds.
    expect(String(rendered)).toContain("counts 1 2 2");
    // Each collection carries the existing normalized contract.
    expect(String(rendered)).toContain('"state": "approved"');
    expect(String(rendered)).toContain('"author": "reviewer"');
    expect(String(rendered)).toContain('"kind": "conversation"');
    expect(String(rendered)).toContain('"kind": "review"');
    expect(String(rendered)).toContain('"diffHunk"');
    expect(String(rendered)).toContain('"kind": "check-run"');
    expect(String(rendered)).toContain('"conclusion": "failure"');
    expect(String(rendered)).toContain('"kind": "commit-status"');
    expect(String(rendered)).toContain('"state": "error"');

    // Each read reached the route its own collection lives at.
    const asked = recording.requests.map((request) => new URL(request.url).pathname);
    for (const route of [
      "/repos/octo/project/pulls/4/reviews",
      "/repos/octo/project/issues/4/comments",
      "/repos/octo/project/pulls/4/comments",
      `/repos/octo/project/commits/${HEAD}/check-runs`,
      `/repos/octo/project/commits/${HEAD}/status`,
    ]) {
      expect(`${route}: ${asked.includes(route)}`).toBe(`${route}: true`);
    }
    expect(recording.requests.every((request) => request.authorized)).toBe(true);

    // Outside the ceiling: refused before anything is sent.
    const sent = recording.requests.length;
    const failure = yield* raised(
      runOrdinaryDocument(
        `<PullRequest.Reviews url="https://github.com/other/repo/pull/4" as="reviews" />`,
        { root, cwd: checkout.root, gitHubPullRequests: { allowed: [GITHUB_LOCATOR], access } },
      ),
    );
    expect(String(failure)).toContain("has not authorized");
    expect(recording.requests).toHaveLength(sent);

    // And with nothing allowed, no read this host performs exists at all.
    const unconfigured = yield* raised(
      runOrdinaryDocument(`<PullRequest.Reviews url="${GITHUB_LOCATOR}/pull/4" as="reviews" />`, {
        root,
        cwd: checkout.root,
        gitHubPullRequests: { access },
      }),
    );
    expect(String(unconfigured)).toContain("no pull-request provider handles");
    expect(recording.requests).toHaveLength(sent);
  });

  it("refuses an unpublished head before a credential or a request", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const store = gitHubStore({ token: TOKEN });
    const root = yield* useManagedRoot();
    const checkout = yield* useNamedOriginCheckout(remote, GITHUB_LOCATOR);
    const counting = countingOrdinaryHost(rewritingHost(GITHUB_LOCATOR, remote.locator));

    const failure = yield* raised(
      runOrdinaryDocument(`<PullRequest title="Never published" as="pullRequest" />`, {
        root,
        cwd: checkout.root,
        host: counting.host,
        gitHubPullRequests: { access: gitHubSource(fakeGitHubAccess(store)) },
      }),
    );
    expect(String(failure)).toContain("holds no successful <Git.Push> result");
    expect(store.requests).toHaveLength(0);
    expect(counting.counters.sessions).toEqual([]);
  });
});

describe("ORC12 — exclusive ownership across processes", () => {
  /** One second process, run to completion, and what it reported. */
  function* elsewhere(root: string, cwd: string, source: string): Operation<ChildOutcome> {
    const outcome = spawnSync(
      process.execPath,
      ["run", "--allow-all", "--frozen", CHILD, root, cwd, source],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const printed = outcome.stdout.trim().split("\n").at(-1) ?? "";
    if (printed === "") {
      throw new Error(`the child printed nothing: ${outcome.stderr}`);
    }
    return JSON.parse(printed) as ChildOutcome;
  }

  it("refuses a second process the slot a first is holding, and changes nothing", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const held = worktreeSlotOf(root, commonDirectoryOf(checkout), "contended");
    const free = worktreeSlotOf(root, commonDirectoryOf(checkout), "uncontended");
    // The child renders what it bound, so the parent can read the path back.
    const document = `<Worktree name="contended" branch="contended" as="w" />\n\n{w}`;

    const opened = withResolvers<void>();
    let reached = false;
    const holder = yield* spawn(() =>
      scoped(function* () {
        yield* registerComponents([
          gateComponent(() => {
            if (!reached) {
              reached = true;
              opened.resolve();
            }
          }),
        ]);
        yield* runOrdinaryDocument(
          [
            `<Worktree name="contended" branch="contended">`,
            `<File path="held.md">held by the first process</File>`,
            "<Gate />",
            "</Worktree>",
          ].join("\n"),
          { root, cwd: checkout.root },
        );
      }),
    );
    yield* opened.operation;

    // While the first process holds it, a real second process is refused —
    // without waiting, and with a word the person running it can act on.
    const bytes = yield* fingerprintTree(held.slot);
    const refused = yield* elsewhere(root, checkout.root, document);
    expect(refused.kind).toBe("refused");
    expect(refused.reason).toBe("in-use");
    expect(refused.message).toContain("another process is working in");
    // And nothing under the slot moved.
    expect(yield* fingerprintTree(held.slot)).toEqual(bytes);

    // A different slot is not contended, and succeeds while the first is still
    // held: the lock is per-slot, not per-root.
    const other = yield* elsewhere(
      root,
      checkout.root,
      `<Worktree name="uncontended" branch="uncontended" as="w" />\n\n{w}`,
    );
    expect(other.kind).toBe("selected");
    expect(other.bound).toBe(free.checkout);

    // The first process is cancelled. The kernel releases what it held, and the
    // checkout it made is still there.
    yield* holder.halt();
    expect(yield* exists(`${held.checkout}/held.md`)).toBe(true);

    const afterCancellation = yield* elsewhere(root, checkout.root, document);
    expect(afterCancellation.kind).toBe("selected");
    expect(afterCancellation.bound).toBe(held.checkout);
    // It reused the very checkout the cancelled process left, contents and all.
    expect(yield* exists(`${held.checkout}/held.md`)).toBe(true);
  });

  it("hands a slot on after a normal release, with the checkout intact", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = worktreeSlotOf(root, commonDirectoryOf(checkout), "serial");
    const document = `<Worktree name="serial" branch="serial" as="w" />\n\n{w}`;

    // A first execution completes normally and releases.
    const bound = yield* runOrdinaryDocument(document, { root, cwd: checkout.root });
    expect(String(bound).trim()).toBe(slot.checkout);

    // A real second process then takes it, and finds the same checkout.
    const later = yield* elsewhere(root, checkout.root, document);
    expect(later.kind).toBe("selected");
    expect(later.bound).toBe(slot.checkout);
    expect(yield* readSidecar(slot)).toMatchObject({ kind: "worktree", name: "serial" });
  });
});

/** Two executions in one process must not share a checkout registry. */ /** Two executions in one process must not share a checkout registry. */
describe("ORC12 — one process reuses the lease it already holds", () => {
  it("selects the same slot twice in one execution without asking twice", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout: HostCheckout = yield* useHostCheckout(remote.locator);

    const rendered = yield* runOrdinaryDocument(
      [
        `<Worktree name="twice" branch="twice" as="first" />`,
        `<Worktree name="twice" branch="twice" as="second" />`,
        "",
        "{first === second ? 'same' : 'different'}",
      ].join("\n"),
      { root, cwd: checkout.root },
    );
    expect(String(rendered)).toContain("same");
  });
});
