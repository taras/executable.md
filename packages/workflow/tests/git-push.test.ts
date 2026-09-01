/**
 * Tier WF — `<Git.Push>` as a document writes it.
 *
 * These drive the real component through a real run database, a real local bare
 * remote and a real `git`, because the claim under test is about two places at
 * once: what the other end of the transport holds afterwards, and what this
 * run's journal says it published. Rendered text proves neither — a push
 * renders nothing — so every test here reads the remote's refs and the retained
 * reconciliation record.
 *
 * Nothing here reaches a network. A remote is a bare repository in a temporary
 * directory, and an unreachable host is one that has been deleted.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { Ok, scoped, type Operation } from "effection";
import { lstat } from "@effectionx/fs";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { collect, execute, inlineSource, registerComponents } from "@executablemd/core";
import type { ComponentRegistration } from "@executablemd/core";
import type { Json } from "@executablemd/durable-streams";
import { GitHost } from "../src/git-host/api.ts";
import type { GitHostCall } from "../src/git-host/api.ts";
import { RepositoryContext } from "../src/composition/context.ts";
import {
  GitCompositionProviderError,
  GitOperationAuthorityError,
  GitOperationError,
} from "../src/composition/errors.ts";
import { useCompositionComponents } from "../src/composition/installation.ts";
import type { RepositoryRecord } from "../src/composition/records.ts";
import { parseGitHostReconciliationRecord } from "../src/git-host/records.ts";
import { denoRepositoryHost } from "../src/deno/composition/host.ts";
import type { GitInvocation, GitOutcome } from "../src/deno/composition/host.ts";
import type { WorkflowRunDatabase } from "../src/storage/api.ts";
import { createRun, runPath, useStorageRoot, withStorage } from "./support/storage.ts";
import {
  git as nativeGit,
  moveRemoteBranch,
  remoteBranch,
  remoteRefs,
  useBareRemote,
} from "./support/git-remotes.ts";
import type { BareRemote } from "./support/git-remotes.ts";
import { transactWorkspaceRoots } from "../src/deno/workspace/private.ts";
import type { PrivateWorkspaceTransaction } from "../src/deno/workspace/private.ts";
import {
  causedBy,
  checkoutConfig,
  countingHost,
  countingOptions,
  gitHostEvents,
  gitHostOutcomes,
  headCommit,
  inCheckout,
  raised,
  retainedRepositories,
  retainedWorktrees,
  runWorkflowDocument,
  subcommands,
  survivingRoots,
  workspaceText,
  writeCheckoutFile,
} from "./support/composition.ts";
import type { CountingHost } from "./support/composition.ts";
import { committedRoot, latestRoot, publishedRoots } from "./support/replay.ts";

import type { RepositorySelection } from "../src/composition/selection.ts";
const REMOTE = {
  commits: [
    {
      message: "first",
      entries: [{ path: "which.txt", content: "main\n" }],
    },
    {
      message: "release",
      branch: "release",
      entries: [{ path: "which.txt", content: "release\n" }],
    },
  ],
} as const;

/** A branch whose name has a separator in it, so the ref is not a bare word. */
const BRANCH = "publish/1.4";

const DESTINATION = `refs/heads/${BRANCH}`;

/** Text a suite looks for to say whether work after a failure still ran. */
const LATER = "later sibling ran";

function document(locator: string, ...lines: string[]): string {
  return [`<Repository name="project" url="${locator}">`, ...lines, "</Repository>"].join("\n");
}

/** Switch to a fresh branch and record one commit on it, then push it. */
function published(locator: string, ...extra: string[]): string {
  return document(
    locator,
    `<Git.Switch branch="${BRANCH}" />`,
    `<File path="notes.md">`,
    "prepared",
    "</File>",
    `<Git.Add paths="notes.md" />`,
    `<Git.Commit message="prepare the release" as="commit" />`,
    ...extra,
  );
}

/** Record one more commit on the branch the checkout is on. */
function committed(path: string, content: string, binding: string): string[] {
  return [
    `<File path="${path}">`,
    content,
    "</File>",
    `<Git.Add paths="${path}" />`,
    `<Git.Commit message="record ${path}" as="${binding}" />`,
  ];
}

/** Every Git command of one subcommand this run ran, with its whole argument list. */
function commandsNamed(counting: CountingHost, name: string): string[][] {
  return counting.counters.commands.filter((command) => command[0] === name);
}

/**
 * A test-owned component that moves a branch on the remote mid-document.
 *
 * Mid-document on purpose: the remote has to move after the Repository cloned
 * it, because what a suite is arranging is the state a *second* party left
 * behind while this run was working.
 */
function moveRemote(remote: BareRemote, branch: string, commit: string): ComponentRegistration {
  return {
    name: "MoveRemote",
    origin: "test",
    props: { type: "object", additionalProperties: true },
    // deno-lint-ignore require-yield
    *fn(): Operation<string> {
      moveRemoteBranch(remote, branch, commit);
      return "";
    },
  };
}

/**
 * A test-owned component that builds a commit on the remote and points a branch
 * at it.
 *
 * The object a fast-forward proof cannot read. It has to be made *after* the
 * Repository cloned, because a local clone copies the object database whole —
 * unreachable objects included — so a commit built beforehand would be sitting
 * in the checkout this run authenticated.
 */
function publishOnlyOnRemote(
  remote: BareRemote,
  branch: string,
  into: { commit: string },
): ComponentRegistration {
  return {
    name: "PublishUnseen",
    origin: "test",
    props: { type: "object", additionalProperties: true },
    // deno-lint-ignore require-yield
    *fn(): Operation<string> {
      const tree = nativeGit(
        ["rev-parse", "refs/heads/main^{tree}"],
        remote.locator,
        remote.locator,
      );
      into.commit = nativeGit(
        ["commit-tree", "-m", "unseen", tree],
        remote.locator,
        remote.locator,
      );
      moveRemoteBranch(remote, branch, into.commit);
      return "";
    },
  };
}

/** A well-formed Repository record naming a Repository nothing retains. */
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
 * A test-owned component that writes bytes into the retained checkout.
 *
 * Reaches past every component on purpose, and mid-document on purpose: what it
 * plants has to be there before `<Git.Push>` expands, and `<File>` renders its
 * content through Markdown rather than writing the exact bytes a Git
 * configuration file is made of.
 */
function plant(
  database: WorkflowRunDatabase,
  configuration: string,
  hook: string,
): ComponentRegistration {
  return {
    name: "Plant",
    origin: "test",
    props: { type: "object", additionalProperties: true },
    *fn(): Operation<string> {
      const checkout = yield* checkoutPath(database);
      const planted = yield* transactWorkspaceRoots(database, function* (workspace) {
        const current = yield* workspace.filesystem.readTextFile(`${checkout}/.git/config`);
        yield* workspace.filesystem.writeFile(
          `${checkout}/.git/config`,
          `${current}\n${configuration}`,
        );
        // The default hook location, so nothing but containment stops it.
        yield* workspace.filesystem.mkdir(`${checkout}/.git/hooks`, { recursive: true });
        yield* workspace.filesystem.writeFile(`${checkout}/.git/hooks/pre-push`, hook, 0o755);
        const captured = yield* workspace.capture();
        yield* workspace.publish(captured.rootId);
      });
      if (!planted.ok) {
        throw planted.error;
      }
      return "";
    },
  };
}

/**
 * A test-owned component that edits the retained checkout's object graph.
 *
 * Mid-document on purpose: what it writes has to be there when `<Git.Push>`
 * expands, and only a fixture can plant a symbolic link or an alternates file
 * no supported operation produces.
 */
function plantObjectGraph(
  database: WorkflowRunDatabase,
  edit: (workspace: PrivateWorkspaceTransaction, checkout: string) => Operation<void>,
): ComponentRegistration {
  return {
    name: "Plant",
    origin: "test",
    props: { type: "object", additionalProperties: true },
    *fn(): Operation<string> {
      const checkout = yield* checkoutPath(database);
      const planted = yield* transactWorkspaceRoots(database, function* (workspace) {
        yield* edit(workspace, checkout);
        const captured = yield* workspace.capture();
        yield* workspace.publish(captured.rootId);
      });
      if (!planted.ok) {
        throw planted.error;
      }
      return "";
    },
  };
}

/** Whether the host holds anything at this path. */
function* present(path: string): Operation<boolean> {
  try {
    yield* lstat(path);
    return true;
  } catch {
    return false;
  }
}

function isGitFailure(value: unknown): value is GitOperationError {
  return value instanceof GitOperationError;
}

function isAuthorityFailure(value: unknown): value is GitOperationAuthorityError {
  return value instanceof GitOperationAuthorityError;
}

function isProviderError(value: unknown): value is GitCompositionProviderError {
  return value instanceof GitCompositionProviderError;
}

/** What the run retains for its one Repository, so a suite can read a checkout. */
function* checkoutPath(database: WorkflowRunDatabase): Operation<string> {
  const [repository] = yield* retainedRepositories(database);
  if (repository === undefined) {
    throw new Error("the run retains no Repository");
  }
  return repository.record.checkoutPath;
}

describe("workflow Git.Push", () => {
  it("publishes the primary checkout's current branch to origin", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, "release-1.4");

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();
      yield* runWorkflowDocument(
        database,
        published(remote.locator, `<Git.Push />`),
        countingOptions(counting),
      );

      const head = yield* headCommit(database, yield* checkoutPath(database));
      expect(head.branch).toBe(BRANCH);
      // The other end holds exactly the commit the checkout is on, under the
      // full destination ref rather than under a name Git shortened.
      expect(remoteBranch(remote, BRANCH)).toBe(head.commit);

      const [outcome] = yield* gitHostOutcomes(database);
      expect(outcome?.status).toBe("ok");
      const record = parseGitHostReconciliationRecord(outcome?.record);
      expect(record?.decision).toBe("performed");
      expect(record?.preState).toEqual({ remoteCommit: null });
      expect(record?.observations).toEqual({ remoteCommit: head.commit });
      const [repository] = yield* retainedRepositories(database);
      const identity = repository?.record;
      expect(record?.result).toEqual({
        repository: {
          name: "project",
          locatorFingerprint: identity?.locatorFingerprint,
          requestedBase: null,
          creationCommit: identity?.creationCommit,
          primaryBranch: "main",
          objectFormat: "sha1",
        },
        remote: "origin",
        branch: BRANCH,
        destinationRef: DESTINATION,
        refspec: `${head.commit}:${DESTINATION}`,
        sourceCommit: head.commit,
        observedRemoteCommit: head.commit,
      });

      // Observed before it mutated, and mutated once.
      expect(subcommands(counting.counters).filter((name) => name === "ls-remote")).toHaveLength(1);
      expect(subcommands(counting.counters).filter((name) => name === "push")).toHaveLength(1);
      expect(yield* survivingRoots(counting.counters)).toEqual([]);
      // The Repository, the switch, the write, the staging and the commit each
      // published a root; the push published none, because it moved nothing
      // here.
      expect(publishedRoots(path)).toBe(5);
    });
  });

  it("retains no checkout path, locator or host path in what it publishes", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runWorkflowDocument(database, published(remote.locator, `<Git.Push />`));

      const checkout = yield* checkoutPath(database);
      const [event] = yield* gitHostEvents(database);
      const journaled = JSON.stringify(event);

      expect(journaled).not.toContain(checkout);
      expect(journaled).not.toContain(remote.locator);
      expect(journaled).not.toContain("checkoutPath");
      expect(journaled).not.toContain("/private/tmp");
      expect(journaled).not.toContain("/var/folders");
    });
  });

  it("publishes the branch of the linked worktree the working directory selects", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runWorkflowDocument(
        database,
        document(
          remote.locator,
          `<Worktree name="implementation" branch="feature/new" as="worktree" />`,
          "<Dir path={worktree}>",
          `<Git.Push />`,
          "</Dir>",
        ),
      );

      const [worktree] = yield* retainedWorktrees(database, "project");
      const head = yield* headCommit(database, worktree?.checkoutPath ?? "");
      expect(head.branch).toBe("feature/new");
      expect(remoteBranch(remote, "feature/new")).toBe(head.commit);

      const record = parseGitHostReconciliationRecord(
        (yield* gitHostOutcomes(database))[0]?.record,
      );
      expect(Reflect.get(Object(record?.result), "branch")).toBe("feature/new");
      expect(Reflect.get(Object(record?.result), "destinationRef")).toBe("refs/heads/feature/new");
    });
  });

  it("adopts a destination that already holds the commit, and pushes nothing more", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();
      yield* runWorkflowDocument(
        database,
        published(remote.locator, `<Git.Push />`, `<Git.Push />`),
        countingOptions(counting),
      );

      const head = yield* headCommit(database, yield* checkoutPath(database));
      const outcomes = yield* gitHostOutcomes(database);
      expect(outcomes).toHaveLength(2);
      expect(parseGitHostReconciliationRecord(outcomes[0]?.record)?.decision).toBe("performed");

      const adopted = parseGitHostReconciliationRecord(outcomes[1]?.record);
      expect(adopted?.decision).toBe("adopted");
      expect(adopted?.preState).toEqual({ remoteCommit: head.commit });
      expect(Reflect.get(Object(adopted?.result), "observedRemoteCommit")).toBe(head.commit);

      // Two observations, one mutation: adoption is what makes an interrupted
      // attempt reach the remote once rather than twice.
      expect(subcommands(counting.counters).filter((name) => name === "ls-remote")).toHaveLength(2);
      expect(subcommands(counting.counters).filter((name) => name === "push")).toHaveLength(1);
    });
  });

  /**
   * The second iteration of a supervised loop, which is what this operation is
   * written for.
   *
   * A branch is published, worked on and published again, and the second
   * publication is an ordinary fast-forward: the remote holds a commit this one
   * was built on top of. Advancing it is what "push this branch" means, so it
   * is the same exact non-force refspec the first publication used — no force,
   * no lease, no second remote, and nothing local rewritten to make it apply.
   *
   * There is an unpushed commit between the two, so what the second push proves
   * is that the published commit is *somewhere* in this one's ancestry. A proof
   * that only recognized equality or parenthood would fail here.
   */
  it("advances a branch it published to a later commit that contains it", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();
      yield* runWorkflowDocument(
        database,
        published(
          remote.locator,
          `<Git.Push />`,
          ...committed("middle.md", "between the two", "middle"),
          ...committed("more.md", "the second iteration", "second"),
          `<Git.Push />`,
        ),
        countingOptions(counting),
      );

      const head = yield* headCommit(database, yield* checkoutPath(database));
      // The other end advanced: it holds the commit this run is on now.
      expect(remoteBranch(remote, BRANCH)).toBe(head.commit);

      const outcomes = yield* gitHostOutcomes(database);
      expect(outcomes).toHaveLength(2);
      expect(outcomes[0]?.status).toBe("ok");
      expect(outcomes[1]?.status).toBe("ok");
      const first = parseGitHostReconciliationRecord(outcomes[0]?.record);
      const second = parseGitHostReconciliationRecord(outcomes[1]?.record);
      const published1 = String(Reflect.get(Object(first?.result), "sourceCommit"));
      expect(first?.decision).toBe("performed");
      expect(first?.preState).toEqual({ remoteCommit: null });
      // Transitive rather than immediate: the commit the remote held is not a
      // parent of the one that replaced it.
      expect(head.parents).not.toContain(published1);

      // The predecessor is retained, and so is the fact that made publishing
      // over it an advance rather than a replacement.
      expect(second?.decision).toBe("performed");
      expect(second?.preState).toEqual({ remoteCommit: published1, relation: "ancestor" });
      expect(second?.observations).toEqual({ remoteCommit: head.commit });
      expect(second?.result).toEqual({
        ...Object(first?.result),
        refspec: `${head.commit}:${DESTINATION}`,
        sourceCommit: head.commit,
        observedRemoteCommit: head.commit,
      });

      // Observed before each mutation, and each publication is one push.
      expect(subcommands(counting.counters).filter((name) => name === "ls-remote")).toHaveLength(2);
      const pushed = commandsNamed(counting, "push");
      // One exact refspec each, and nothing implicit around either of them.
      expect(pushed.map((command) => command[command.length - 1])).toEqual([
        `${published1}:${DESTINATION}`,
        `${head.commit}:${DESTINATION}`,
      ]);
      for (const command of pushed) {
        expect(command.join(" ")).not.toContain("--force");
        expect(command.join(" ")).not.toContain("--set-upstream");
      }
      // Nothing fetched an object, and nothing moved local history to make the
      // advance apply.
      for (const forbidden of ["fetch", "reset", "merge", "rebase"]) {
        expect(subcommands(counting.counters)).not.toContain(forbidden);
      }
      // And the advance establishes no tracking, exactly as a creation does not.
      const configured = yield* checkoutConfig(database, yield* checkoutPath(database), [
        `branch.${BRANCH}.remote`,
        `branch.${BRANCH}.merge`,
      ]);
      expect(configured.get(`branch.${BRANCH}.remote`)).toBe(undefined);
      expect(configured.get(`branch.${BRANCH}.merge`)).toBe(undefined);
    });
  });

  /**
   * A destination this commit does not contain, with nothing missing.
   *
   * Both commits are in the authenticated object source — the remote's own
   * `release` commit came with the clone — so the refusal is proven divergence
   * rather than an object the run could not read. That distinction is the whole
   * of what separates this from the case below it.
   */
  it("refuses a destination holding a commit this one does not contain", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    // A commit on another line of the remote's history: the clone brought it
    // along, and nothing this run commits is built on it.
    const diverged = remote.heads.get("release") ?? "";

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();

      const failure = yield* raised(
        runWorkflowDocument(
          database,
          document(
            remote.locator,
            `<MoveRemote />`,
            ...committed("notes.md", "diverged", "commit"),
            `<Git.Push />`,
            "",
            LATER,
          ),
          countingOptions(counting),
          (run) =>
            scoped(function* () {
              yield* registerComponents([moveRemote(remote, "main", diverged)]);
              return yield* run();
            }),
        ),
      );

      expect(String(failure)).toContain("conflicts");
      expect(String(failure)).not.toContain(LATER);
      // The remote is exactly what the other party left: nothing was forced,
      // reset, merged or rebased to make the push apply.
      expect(remoteBranch(remote, "main")).toBe(diverged);
      expect(subcommands(counting.counters)).not.toContain("push");
      expect(subcommands(counting.counters)).not.toContain("fetch");
      // Divergence was decided, rather than assumed from a missing object.
      expect(subcommands(counting.counters)).toContain("merge-base");

      const [outcome] = yield* gitHostOutcomes(database);
      expect(outcome?.status).toBe("err");
      expect(outcome?.name).toBe("GitHostConflictError");

      // The commit really was readable here: what the destination holds is a
      // commit this run has, and still does not contain.
      const held = yield* inCheckout(database, yield* checkoutPath(database), function* (run) {
        return (yield* run(["cat-file", "-t", diverged])).trim();
      });
      expect(held).toBe("commit");

      // A refusal changes no tracking either. `main` is the branch the clone
      // established tracking for; what matters is that the refused push left
      // exactly that and did not repoint it.
      const configured = yield* checkoutConfig(database, yield* checkoutPath(database), [
        "branch.main.remote",
        "branch.main.merge",
      ]);
      expect(configured.get("branch.main.remote")).toBe("origin");
      expect(configured.get("branch.main.merge")).toBe("refs/heads/main");
    });
  });

  /**
   * A destination naming a commit this run has no way to read.
   *
   * Compatibility is something to prove, not something to go and get: fetching
   * the object would manufacture the very ancestry being asked about. So an
   * observation the authenticated source cannot decide is an ordinary conflict,
   * and the proof stops before it asks Git about ancestry at all.
   */
  it("refuses a destination whose commit the authenticated source cannot read", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();
      // Filled in mid-document, after this run cloned: an object no local
      // database holds and nothing short of a fetch would bring here.
      const unseen = { commit: "" };

      const failure = yield* raised(
        runWorkflowDocument(
          database,
          published(remote.locator, `<PublishUnseen />`, `<Git.Push />`, "", LATER),
          countingOptions(counting),
          (run) =>
            scoped(function* () {
              yield* registerComponents([publishOnlyOnRemote(remote, BRANCH, unseen)]);
              return yield* run();
            }),
        ),
      );

      expect(String(failure)).toContain("conflicts");
      expect(String(failure)).not.toContain(LATER);
      expect(remoteBranch(remote, BRANCH)).toBe(unseen.commit);
      expect(subcommands(counting.counters)).not.toContain("push");
      // Nothing went and got the object, and nothing asked about the ancestry
      // of an object this run does not hold.
      expect(subcommands(counting.counters)).not.toContain("fetch");
      expect(subcommands(counting.counters)).not.toContain("merge-base");

      const [outcome] = yield* gitHostOutcomes(database);
      expect(outcome?.status).toBe("err");
      expect(outcome?.name).toBe("GitHostConflictError");

      // The object really was unreadable here, which is what makes the refusal
      // this case rather than the divergence one above.
      const reached = yield* raised(
        inCheckout(database, yield* checkoutPath(database), function* (run) {
          return yield* run(["cat-file", "-t", unseen.commit]);
        }),
      );
      expect(reached).toBeInstanceOf(Error);
    });
  });

  /**
   * An ancestry proof that answers neither of the two things it can answer.
   *
   * `merge-base --is-ancestor` says ancestry with 0 and divergence with 1.
   * Anything else means the proof did not run or did not decide — and a
   * decision nobody reached is not a finding about the remote, so it fails at
   * the boundary rather than becoming a conflict or an advance.
   */
  it("fails at the boundary when the ancestry proof cannot answer", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const inner = denoRepositoryHost();
      const counting = countingHost({
        *git(invocation: GitInvocation): Operation<GitOutcome> {
          if (invocation.args[0] === "merge-base") {
            return { code: 3, stdout: "", stderr: "" };
          }
          return yield* inner.git(invocation);
        },
        useDirectory: inner.useDirectory,
      });

      const failure = yield* raised(
        runWorkflowDocument(
          database,
          published(
            remote.locator,
            `<Git.Push />`,
            ...committed("more.md", "the second iteration", "second"),
            `<Git.Push />`,
            "",
            LATER,
          ),
          countingOptions(counting),
        ),
      );

      // One fixed, cause-free boundary failure: no outcome is published for it
      // and the run fail-stops.
      expect(String(failure)).toContain("executed and published nothing");
      expect(String(failure)).not.toContain(LATER);
      // The first publication is the only Git-host record, and the destination
      // still holds exactly what that one published.
      const outcomes = yield* gitHostOutcomes(database);
      expect(outcomes).toHaveLength(1);
      const published1 = Reflect.get(
        Object(parseGitHostReconciliationRecord(outcomes[0]?.record)?.result),
        "sourceCommit",
      );
      expect(remoteBranch(remote, BRANCH)).toBe(published1);
      expect(commandsNamed(counting, "push")).toHaveLength(1);
    });
  });

  /**
   * A push that landed and said it had not.
   *
   * What Git printed is not evidence, and neither is its exit status on its
   * own: the refspec may well have applied. One more exact observation is the
   * whole of what a nonzero push earns, and it is the ref equalling the commit
   * — not the status, not the output — that settles the attempt.
   */
  it("reobserves an uncertain advance once, and mutates the remote no further", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const inner = denoRepositoryHost();
      let attempts = 0;
      const counting = countingHost({
        *git(invocation: GitInvocation): Operation<GitOutcome> {
          const outcome = yield* inner.git(invocation);
          if (invocation.args[0] !== "push") {
            return outcome;
          }
          attempts += 1;
          // The advance really lands; only the answer to it is lost.
          return attempts === 2 ? { code: 1, stdout: "", stderr: "remote: ?" } : outcome;
        },
        useDirectory: inner.useDirectory,
      });

      yield* runWorkflowDocument(
        database,
        published(
          remote.locator,
          `<Git.Push />`,
          ...committed("more.md", "the second iteration", "second"),
          `<Git.Push />`,
        ),
        countingOptions(counting),
      );

      const head = yield* headCommit(database, yield* checkoutPath(database));
      expect(remoteBranch(remote, BRANCH)).toBe(head.commit);

      const outcomes = yield* gitHostOutcomes(database);
      expect(outcomes[1]?.status).toBe("ok");
      const second = parseGitHostReconciliationRecord(outcomes[1]?.record);
      expect(second?.decision).toBe("performed");
      expect(second?.observations).toEqual({ remoteCommit: head.commit });

      // Two publications, two pushes: the uncertain one earned exactly one
      // extra observation and no second attempt at the remote.
      expect(commandsNamed(counting, "push")).toHaveLength(2);
      expect(subcommands(counting.counters).filter((name) => name === "ls-remote")).toHaveLength(3);
    });
  });

  it("fails before observing a remote when HEAD names no branch", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();
      // A checkout's `.git` is inside the Workspace, so a document can write
      // one — which is the only way to reach a detached HEAD, since no
      // operation this provider offers leaves one.
      const failure = yield* raised(
        runWorkflowDocument(
          database,
          document(
            remote.locator,
            `<File path="notes.md">`,
            "prepared",
            "</File>",
            `<Git.Add paths="notes.md" />`,
            `<Git.Commit message="prepare the release" as="commit" />`,
            `<File path=".git/HEAD">{commit}</File>`,
            `<Git.Push />`,
            "",
            LATER,
          ),
          countingOptions(counting),
        ),
      );

      const refusal = causedBy(failure, isGitFailure);
      expect(refusal?.operation).toBe("<Git.Push>");
      expect(refusal?.reason).toBe("unnamed-branch");
      expect(String(failure)).not.toContain(LATER);
      // Decided from the checkout, before a Git-host effect or a remote exists.
      expect(subcommands(counting.counters)).not.toContain("ls-remote");
      expect(subcommands(counting.counters)).not.toContain("push");
      expect(yield* gitHostEvents(database)).toHaveLength(0);
      expect(remoteRefs(remote).size).toBe(2);
    });
  });

  it("fails outside a Repository without reaching a remote", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();
      const failure = yield* raised(
        runWorkflowDocument(
          database,
          [
            `<Repository name="project" url="${remote.locator}" as="repository" />`,
            `<Git.Push />`,
            "",
            LATER,
          ].join("\n"),
          countingOptions(counting),
        ),
      );

      expect(causedBy(failure, isAuthorityFailure)).toBeInstanceOf(GitOperationAuthorityError);
      expect(String(failure)).not.toContain(LATER);
      expect(subcommands(counting.counters)).not.toContain("ls-remote");
      expect(yield* gitHostEvents(database)).toHaveLength(0);
    });
  });

  it("fails against a Repository record this run does not retain", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();
      const failure = yield* raised(
        runWorkflowDocument(
          database,
          [
            `<Repository name="project" url="${remote.locator}" as="repository" />`,
            "<Dir path={repository}>",
            `<Git.Push />`,
            "</Dir>",
          ].join("\n"),
          countingOptions(counting),
          // A self-closing Repository installs no context of its own, so the
          // record the component observes is exactly this one — which is what a
          // replaced context is.
          (run) =>
            scoped(function* () {
              yield* RepositoryContext.around({ current: () => FORGED }, { at: "min" });
              return yield* run();
            }),
        ),
      );

      expect(causedBy(failure, isAuthorityFailure)).toBeInstanceOf(GitOperationAuthorityError);
      expect(subcommands(counting.counters)).not.toContain("ls-remote");
      expect(subcommands(counting.counters)).not.toContain("push");
      expect(yield* gitHostEvents(database)).toHaveLength(0);
    });
  });

  it("fails when the working directory is inside no retained checkout", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();
      // The enclosing Repository is `project`; the working directory is another
      // Repository's checkout. Both are this run's, and the pair is not.
      const failure = yield* raised(
        runWorkflowDocument(
          database,
          [
            `<Repository name="other" url="${remote.locator}" as="other" />`,
            `<Repository name="project" url="${remote.locator}">`,
            "<Dir path={other}>",
            `<Git.Push />`,
            "</Dir>",
            "</Repository>",
          ].join("\n"),
          countingOptions(counting),
        ),
      );

      expect(causedBy(failure, isAuthorityFailure)).toBeInstanceOf(GitOperationAuthorityError);
      expect(subcommands(counting.counters)).not.toContain("ls-remote");
      expect(subcommands(counting.counters)).not.toContain("push");
      expect(yield* gitHostEvents(database)).toHaveLength(0);
    });
  });

  it("leaves local upstream tracking exactly as it found it", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runWorkflowDocument(database, published(remote.locator, `<Git.Push />`));

      const configured = yield* checkoutConfig(database, yield* checkoutPath(database), [
        `branch.${BRANCH}.remote`,
        `branch.${BRANCH}.merge`,
        "branch.main.remote",
        "branch.main.merge",
      ]);
      // A successful push establishes nothing: `--set-upstream` is not one of
      // the options this operation has, and there is no prop that asks for it.
      expect(configured.get(`branch.${BRANCH}.remote`)).toBe(undefined);
      expect(configured.get(`branch.${BRANCH}.merge`)).toBe(undefined);
      // The branch a clone did establish is untouched.
      expect(configured.get("branch.main.remote")).toBe("origin");
      expect(configured.get("branch.main.merge")).toBe("refs/heads/main");
    });
  });

  it("is an ordinary default a nested registration shadows", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();
      const output = yield* runWorkflowDocument(
        database,
        document(remote.locator, `<Git.Push />`),
        countingOptions(counting),
        (run) =>
          scoped(function* () {
            yield* registerComponents([
              {
                name: "Git.Push",
                origin: "test",
                props: { type: "object", additionalProperties: true },
                // deno-lint-ignore require-yield
                *fn(): Operation<string> {
                  return "shadowed";
                },
              },
            ]);
            return yield* run();
          }),
      );

      expect(String(output)).toContain("shadowed");
      expect(yield* gitHostEvents(database)).toHaveLength(0);
      expect(subcommands(counting.counters)).not.toContain("ls-remote");
    });
  });

  it("acquires no provider under an ordinary run", function* () {
    const root = yield* useStorageRoot();

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const failure = yield* raised(
        scoped(function* () {
          yield* useCompositionComponents();
          yield* RepositoryContext.around({ current: () => FORGED }, { at: "min" });
          return yield* collect(
            yield* execute({ ...inlineSource(`<Git.Push />`), stream: database.journal }),
          );
        }),
      );

      // There is no host-less fallback. A Push that "ran" without a provider
      // would report a branch this run never published.
      expect(causedBy(failure, isProviderError)).toBeInstanceOf(GitCompositionProviderError);
    });
  });

  it("publishes nothing when native Git refuses the push for a reason it has no word for", function* () {
    const root = yield* useStorageRoot();
    // `refs/heads/release` already exists, so Git cannot also create
    // `refs/heads/release/1.4`: a real refused push whose cause is neither a
    // conflicting destination nor an unreachable host.
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();
      const failure = yield* raised(
        runWorkflowDocument(
          database,
          document(remote.locator, `<Git.Switch branch="release/1.4" />`, `<Git.Push />`),
          countingOptions(counting),
        ),
      );

      // One fixed, cause-free boundary failure: nothing Git printed travels
      // with it, and no completion is invented for a push nobody proved.
      expect(String(failure)).toContain("executed and published nothing");
      expect(String(failure)).not.toContain("cannot lock ref");
      // Observed once before, and once more after the refusal, and never forced.
      expect(subcommands(counting.counters).filter((name) => name === "push")).toHaveLength(1);
      expect(remoteRefs(remote).has("refs/heads/release/1.4")).toBe(false);
      expect(remoteBranch(remote, "release")).toBe(remote.heads.get("release"));
      // A boundary failure is not an outcome, so the journal holds none.
      expect(yield* gitHostEvents(database)).toHaveLength(0);
    });
  });
});

describe("workflow Git.Push containment", () => {
  /**
   * A checkout's own configuration is retained document data, not an
   * instruction to the run.
   *
   * Every setting planted here is one that would change where this push goes,
   * what signs it, or what else runs while it happens — and all of them are
   * things a document can put in a Workspace the run restores on replay. The
   * hook sits at the default `.git/hooks/pre-push`, so nothing but containment
   * stops it.
   *
   * The trap is armed rather than assumed: after the push, the same checkout is
   * pushed from the ordinary way, and that one is redirected and refused. A
   * planted configuration Git would have ignored anyway would prove nothing.
   */
  it("publishes to the retained locator despite a hostile checkout configuration", function* () {
    const root = yield* useStorageRoot();
    const witness = yield* useTempDirectory("xmd-push-hook-");
    const sentinel = `${witness}/pre-push-ran`;
    const remote = yield* useBareRemote(REMOTE);
    const decoy = yield* useBareRemote({
      commits: [{ message: "decoy", entries: [{ path: "decoy.txt", content: "decoy\n" }] }],
    });
    const hostile = [
      `[remote "origin"]`,
      `\tpushurl = ${decoy.locator}`,
      `[url "${decoy.locator}"]`,
      `\tpushInsteadOf = ${remote.locator}`,
      `[push]`,
      `\tgpgSign = true`,
      "",
    ].join("\n");
    const hook = [
      "#!/bin/sh",
      `echo ran > ${sentinel}`,
      `echo "the hostile pre-push hook ran" >&2`,
      "exit 1",
      "",
    ].join("\n");

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();
      yield* runWorkflowDocument(
        database,
        document(remote.locator, `<Git.Switch branch="${BRANCH}" />`, `<Plant />`, `<Git.Push />`),
        countingOptions(counting),
        (run) =>
          scoped(function* () {
            yield* registerComponents([plant(database, hostile, hook)]);
            return yield* run();
          }),
      );

      const checkout = yield* checkoutPath(database);
      const head = yield* headCommit(database, checkout);
      // The retained locator decided the destination, not `pushurl` and not the
      // rewrite: the real remote has the branch and the decoy has nothing.
      expect(remoteBranch(remote, BRANCH)).toBe(head.commit);
      expect(remoteBranch(decoy, BRANCH)).toBe(undefined);
      expect(yield* present(sentinel)).toBe(false);
      expect(subcommands(counting.counters).filter((name) => name === "push")).toHaveLength(1);
      expect(yield* gitHostOutcomes(database)).toHaveLength(1);
      expect((yield* gitHostOutcomes(database))[0]?.status).toBe("ok");

      // The trap really was armed. The same checkout, pushed the ordinary way
      // — with its own configuration in force rather than the provider's fixed
      // one — is refused by the hook and never reaches the real remote.
      const ordinary = yield* inCheckout(database, checkout, function* (run) {
        const top = (yield* run(["rev-parse", "--show-toplevel"])).trim();
        try {
          nativeGit(["push", "origin", `${BRANCH}:refs/heads/ordinary`], top, top);
          return "the ordinary push was not refused";
        } catch (error) {
          return String(error);
        }
      });
      expect(String(ordinary)).toContain("the hostile pre-push hook ran");
      // And it was aimed at the decoy, so the redirect was live too.
      expect(String(ordinary)).toContain(decoy.locator);
      expect(yield* present(sentinel)).toBe(true);
      expect(remoteRefs(remote).has("refs/heads/ordinary")).toBe(false);
      expect(remoteRefs(decoy).has("refs/heads/ordinary")).toBe(false);
    });
  });

  /**
   * What public Git-host middleware is shown, and what it can do with it.
   *
   * One frozen routing request describing the detached ask, and nothing that is
   * a capability. The object source, the retained locator, the control
   * repository and every host path stay in the provider's own closure — so a
   * handler cannot redirect the push, and a value it returns cannot become the
   * effect's outcome.
   */
  it("shows routing middleware the frozen request and nothing that can answer it", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const seen: GitHostCall[] = [];
      yield* runWorkflowDocument(database, published(remote.locator, `<Git.Push />`), {}, (run) =>
        scoped(function* () {
          yield* GitHost.around({
            *route([call], next): Operation<unknown> {
              seen.push(call);
              yield* next(call);
              // A return value is not evidence, and this one is discarded.
              return Ok({ observations: { forged: true }, result: { forged: true } });
            },
          });
          return yield* run();
        }),
      );

      expect(seen).toHaveLength(2);
      const phases = seen.map((call) => (call.intent === "route" ? call.phase : "private"));
      expect(phases).toEqual(["observe", "perform"]);

      for (const call of seen) {
        expect(Object.keys(call).sort()).toEqual(["intent", "phase", "request"]);
        const request = Reflect.get(call, "request");
        expect(Object.keys(Object(request)).sort()).toEqual([
          "identity",
          "inputs",
          "kind",
          "naturalKey",
        ]);
        expect(Object.isFrozen(call)).toBe(true);
        const described = JSON.stringify(call);
        expect(described).not.toContain(remote.locator);
        expect(described).not.toContain("/private/var");
        expect(described).not.toContain("/var/folders");
        expect(described).not.toContain("control");
        // Nothing on it is a function, so there is nothing to invoke.
        for (const value of Object.values(Object(request))) {
          expect(typeof value).not.toBe("function");
        }
      }

      // What the middleware returned was ignored: the record is the provider's.
      const head = yield* headCommit(database, yield* checkoutPath(database));
      const record = parseGitHostReconciliationRecord(
        (yield* gitHostOutcomes(database))[0]?.record,
      );
      expect(record?.decision).toBe("performed");
      expect(Reflect.get(Object(record?.result), "sourceCommit")).toBe(head.commit);
      expect(remoteBranch(remote, BRANCH)).toBe(head.commit);
    });
  });

  it("publishes nothing when routing middleware refuses to delegate", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();
      const failure = yield* raised(
        runWorkflowDocument(
          database,
          published(remote.locator, `<Git.Push />`),
          countingOptions(counting),
          (run) =>
            scoped(function* () {
              yield* GitHost.around({
                // deno-lint-ignore require-yield
                *route(): Operation<unknown> {
                  return Ok({ observations: {}, result: {} });
                },
              });
              return yield* run();
            }),
        ),
      );

      expect(String(failure)).toContain("executed and published nothing");
      expect(subcommands(counting.counters)).not.toContain("ls-remote");
      expect(subcommands(counting.counters)).not.toContain("push");
      expect(yield* gitHostEvents(database)).toHaveLength(0);
      expect(remoteRefs(remote).has(DESTINATION)).toBe(false);
    });
  });

  it("publishes the shared unavailability when the host cannot answer", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const inner = denoRepositoryHost();
      const counting = countingHost({
        *git(invocation: GitInvocation): Operation<GitOutcome> {
          if (invocation.args[0] === "ls-remote") {
            return { code: 128, stdout: "", stderr: "fatal: could not read from remote" };
          }
          return yield* inner.git(invocation);
        },
        useDirectory: inner.useDirectory,
      });

      const failure = yield* raised(
        runWorkflowDocument(
          database,
          published(remote.locator, `<Git.Push />`),
          countingOptions(counting),
        ),
      );

      expect(String(failure)).toContain("temporarily unavailable");
      const [outcome] = yield* gitHostOutcomes(database);
      expect(outcome?.status).toBe("err");
      expect(outcome?.name).toBe("GitHostUnavailableError");
      // Silence is not absence: nothing was performed on this answer.
      expect(subcommands(counting.counters)).not.toContain("push");
      expect(remoteRefs(remote).has(DESTINATION)).toBe(false);
    });
  });

  it("publishes the shared ambiguity when the destination cannot be decided", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const inner = denoRepositoryHost();
      const counting = countingHost({
        *git(invocation: GitInvocation): Operation<GitOutcome> {
          if (invocation.args[0] === "ls-remote") {
            // One successful transport, two answers for one ref.
            const oid = "0".repeat(40);
            return {
              code: 0,
              stdout: `${oid}\t${DESTINATION}\n${"1".repeat(40)}\t${DESTINATION}\n`,
              stderr: "",
            };
          }
          return yield* inner.git(invocation);
        },
        useDirectory: inner.useDirectory,
      });

      const failure = yield* raised(
        runWorkflowDocument(
          database,
          published(remote.locator, `<Git.Push />`),
          countingOptions(counting),
        ),
      );

      expect(String(failure)).toContain("cannot prove whether this effect already happened");
      const [outcome] = yield* gitHostOutcomes(database);
      expect(outcome?.status).toBe("err");
      expect(outcome?.name).toBe("GitHostAmbiguousError");
      expect(subcommands(counting.counters)).not.toContain("push");
      expect(remoteRefs(remote).has(DESTINATION)).toBe(false);
    });
  });
});

describe("workflow Git.Push object-source containment", () => {
  /**
   * The alternate an author can write, and what happens when they do.
   *
   * The control repository reads the checkout's object database, and an object
   * database says where Git reads *next*: `objects/info/alternates` is a file
   * inside the Workspace, so a document that writes one is choosing which
   * objects a push may publish. It is rejected rather than deleted or ignored —
   * repairing it would publish from a database this run edited, and ignoring it
   * would publish from a database that is not the one it verified.
   *
   * The escape is proven real rather than assumed: the same alternate, read by
   * an ordinary `git` in the same export, does reach the foreign commit.
   */
  it("refuses an object graph whose alternates leave the authenticated database", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, "release-1.4");
    const foreign = yield* useBareRemote({
      commits: [{ message: "foreign", entries: [{ path: "foreign.txt", content: "foreign\n" }] }],
    });
    const foreignCommit = foreign.heads.get("main") ?? "";
    const foreignObjects = `${foreign.locator}/objects`;

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();
      const failure = yield* raised(
        runWorkflowDocument(
          database,
          document(
            remote.locator,
            `<Git.Switch branch="${BRANCH}" />`,
            `<Plant />`,
            `<Git.Push />`,
          ),
          countingOptions(counting),
          (run) =>
            scoped(function* () {
              yield* registerComponents([
                plantObjectGraph(database, function* (workspace, checkout) {
                  yield* workspace.filesystem.mkdir(`${checkout}/.git/objects/info`, {
                    recursive: true,
                  });
                  yield* workspace.filesystem.writeFile(
                    `${checkout}/.git/objects/info/alternates`,
                    `${foreignObjects}\n`,
                  );
                }),
              ]);
              return yield* run();
            }),
        ),
      );

      // One fixed, cause-free boundary failure. It publishes nothing, activates
      // the run's fail-stop, and repeats no path an author wrote.
      expect(String(failure)).toContain("executed and published nothing");
      expect(String(failure)).not.toContain(foreignObjects);
      expect(String(failure)).not.toContain("alternate");

      // Nothing was observed and nothing was performed.
      expect(subcommands(counting.counters)).not.toContain("ls-remote");
      expect(subcommands(counting.counters)).not.toContain("push");
      expect(yield* gitHostEvents(database)).toHaveLength(0);
      // The Repository, the switch and the plant published a root each; the
      // push published none and moved no frontier.
      expect(publishedRoots(path)).toBe(3);
      expect(committedRoot(path)).toBe(latestRoot(path));
      // And the branch it would have published is still absent.
      expect(remoteRefs(remote).has(DESTINATION)).toBe(false);
      expect(yield* survivingRoots(counting.counters)).toEqual([]);

      // The escape really was reachable: an ordinary Git in the same export,
      // reading the same alternates file, resolves the foreign commit.
      const reached = yield* inCheckout(database, yield* checkoutPath(database), function* (run) {
        const top = (yield* run(["rev-parse", "--show-toplevel"])).trim();
        return nativeGit(["cat-file", "-t", foreignCommit], top, top);
      });
      expect(reached).toBe("commit");
    });
  });

  /**
   * The same escape, spelled the way Git reads it rather than the way a string
   * comparison does.
   *
   * `objects/info/alternates` is not a list of literal lines. An entry
   * beginning with `"` is a C-style quoted path, and Git unquotes it before it
   * resolves anything — so `"/elsewhere/objects"` is an external database to
   * Git and a *relative* path whose first segment is a quote character to
   * anything that compares the spelling. A validator reading it literally is
   * answered by a directory of that literal name planted inside the
   * authenticated database, and the traversal it thinks it described goes
   * somewhere else entirely.
   *
   * Both halves are planted here: the quoted entry Git will follow, and the
   * literal decoy that makes a literal reading accept it.
   */
  it("refuses a quoted alternates entry whose literal spelling has an inside decoy", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, "release-1.4");
    const foreign = yield* useBareRemote({
      commits: [{ message: "foreign", entries: [{ path: "foreign.txt", content: "foreign\n" }] }],
    });
    const foreignCommit = foreign.heads.get("main") ?? "";
    const foreignObjects = `${foreign.locator}/objects`;
    // Valid C-style quoting: the path holds no quote or backslash of its own.
    const quoted = `"${foreignObjects}"`;

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();
      const failure = yield* raised(
        runWorkflowDocument(
          database,
          document(
            remote.locator,
            `<Git.Switch branch="${BRANCH}" />`,
            `<Plant />`,
            `<Git.Push />`,
          ),
          countingOptions(counting),
          (run) =>
            scoped(function* () {
              yield* registerComponents([
                plantObjectGraph(database, function* (workspace, checkout) {
                  const objects = `${checkout}/.git/objects`;
                  yield* workspace.filesystem.mkdir(`${objects}/info`, { recursive: true });
                  yield* workspace.filesystem.writeFile(
                    `${objects}/info/alternates`,
                    `${quoted}\n`,
                  );
                  // The decoy: a real directory inside the authenticated
                  // database whose name is the entry's literal spelling, so a
                  // literal reading resolves it and is satisfied.
                  yield* workspace.filesystem.mkdir(`${objects}/${quoted}`, { recursive: true });
                }),
              ]);
              return yield* run();
            }),
        ),
      );

      // One fixed, cause-free boundary failure, repeating no path an author
      // wrote and no spelling they chose.
      expect(String(failure)).toContain("executed and published nothing");
      expect(String(failure)).not.toContain(foreignObjects);
      expect(String(failure)).not.toContain(quoted);

      expect(subcommands(counting.counters)).not.toContain("ls-remote");
      expect(subcommands(counting.counters)).not.toContain("push");
      expect(yield* gitHostEvents(database)).toHaveLength(0);
      expect(publishedRoots(path)).toBe(3);
      expect(committedRoot(path)).toBe(latestRoot(path));
      expect(remoteRefs(remote).has(DESTINATION)).toBe(false);

      // The escape really was reachable, and reachable through the *quoted*
      // entry: ordinary Git in the same export unquotes it, links the foreign
      // database and resolves a commit this run never held. The decoy is a
      // directory with no objects in it, so nothing but the unquoting explains
      // this answer.
      const reached = yield* inCheckout(database, yield* checkoutPath(database), function* (run) {
        const top = (yield* run(["rev-parse", "--show-toplevel"])).trim();
        return nativeGit(["cat-file", "-t", foreignCommit], top, top);
      });
      expect(reached).toBe("commit");
    });
  });

  /**
   * An escape Git's grammar rejects, which a wider reading turns into a
   * separator.
   *
   * `unquote_c_style()` cases an octal escape's leading digit as `0`–`3`,
   * because an escape names one byte and `\400` is already 256. So `\457` is
   * not a short escape or a near miss — it is an escape Git does not have, and
   * a quoted entry containing one fails to unquote and is read as ordinary
   * literal text instead.
   *
   * A reader that accepted the wider digit would compute 303 and truncate it
   * into a byte, which is 47, which is `/`. It would see a path separator where
   * Git sees no escape at all, and the same entry would then name two different
   * object directories: one inside the authenticated database, reached through
   * segments the extra separator created, and one Git actually traverses.
   *
   * Both are planted. The decoy chain satisfies the truncating reading; the
   * literal spelling Git falls back to reaches a database outside the
   * materialization entirely.
   */
  it("refuses an alternates entry whose octal escape Git's own grammar rejects", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, "release-1.4");
    const foreign = yield* useBareRemote({
      commits: [{ message: "foreign", entries: [{ path: "foreign.txt", content: "foreign\n" }] }],
    });
    const foreignCommit = foreign.heads.get("main") ?? "";

    // `\457` is invalid to Git and decodes to `/` under a truncating reading.
    const escape = "\\457";
    // Quoted: Git rejects the quoting and reads the whole line, including both
    // quotes, as one relative path. Truncating: `a` `/` `b`, two segments.
    const entry = `"a${escape}b/../../foreign"`;
    // Where each reading lands, relative to the object database:
    //   truncating → <objects>/a/b/../../foreign  → <objects>/foreign
    //   Git        → <objects>/"a\457b/../../foreign"  → <repository>/.git/foreign"
    const literalSegment = `"a${escape}b`;
    const foreignSlot = `foreign"`;

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();
      const failure = yield* raised(
        runWorkflowDocument(
          database,
          document(
            remote.locator,
            `<Git.Switch branch="${BRANCH}" />`,
            `<Plant />`,
            `<Git.Push />`,
          ),
          countingOptions(counting),
          (run) =>
            scoped(function* () {
              yield* registerComponents([
                plantObjectGraph(database, function* (workspace, checkout) {
                  const objects = `${checkout}/.git/objects`;
                  yield* workspace.filesystem.mkdir(`${objects}/info`, { recursive: true });
                  yield* workspace.filesystem.writeFile(`${objects}/info/alternates`, `${entry}\n`);
                  // The decoy the truncating reading resolves: the two segments
                  // its invented separator creates, and the directory the
                  // `../..` after them lands back on.
                  yield* workspace.filesystem.mkdir(`${objects}/a/b`, { recursive: true });
                  yield* workspace.filesystem.mkdir(`${objects}/foreign`, { recursive: true });
                  // The one segment Git's literal reading starts from, so its
                  // path resolves rather than merely failing to exist.
                  yield* workspace.filesystem.mkdir(`${objects}/${literalSegment}`, {
                    recursive: true,
                  });
                  // Where Git's literal reading ends: an object database
                  // outside the materialization, holding a commit this run
                  // never had.
                  yield* workspace.filesystem.symlink(
                    `${foreign.locator}/objects`,
                    `${checkout}/.git/${foreignSlot}`,
                  );
                }),
              ]);
              return yield* run();
            }),
        ),
      );

      // One fixed, cause-free boundary failure, repeating nothing an author
      // wrote: not the entry, not its escape, not where it pointed.
      expect(String(failure)).toContain("executed and published nothing");
      expect(String(failure)).not.toContain(entry);
      expect(String(failure)).not.toContain(escape);
      expect(String(failure)).not.toContain(foreign.locator);
      expect(String(failure)).not.toContain(foreignSlot);

      expect(subcommands(counting.counters)).not.toContain("ls-remote");
      expect(subcommands(counting.counters)).not.toContain("push");
      expect(yield* gitHostEvents(database)).toHaveLength(0);
      expect(publishedRoots(path)).toBe(3);
      expect(committedRoot(path)).toBe(latestRoot(path));
      expect(remoteRefs(remote).has(DESTINATION)).toBe(false);

      // The escape really was reachable, and reachable only through Git's own
      // reading of it: ordinary Git in the same export rejects the quoting,
      // resolves the literal spelling, links the outside database and answers
      // for a commit this run never held. The decoy chain holds no objects, so
      // nothing but that fallback explains this.
      const reached = yield* inCheckout(database, yield* checkoutPath(database), function* (run) {
        const top = (yield* run(["rev-parse", "--show-toplevel"])).trim();
        return nativeGit(["cat-file", "-t", foreignCommit], top, top);
      });
      expect(reached).toBe("commit");
    });
  });

  /**
   * The link an author can write, which needs no chain at all.
   *
   * The operating system resolves a symbolic link before Git reports anything
   * about it, so a linked `objects/pack` makes an external directory the thing
   * packs are read from while every question asked about the object database
   * still answers correctly.
   */
  it("refuses an object graph that leaves the database through a symbolic link", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, "release-1.4");
    const foreign = yield* useBareRemote({
      commits: [{ message: "foreign", entries: [{ path: "foreign.txt", content: "foreign\n" }] }],
    });

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();
      const failure = yield* raised(
        runWorkflowDocument(
          database,
          document(
            remote.locator,
            `<Git.Switch branch="${BRANCH}" />`,
            `<Plant />`,
            `<Git.Push />`,
          ),
          countingOptions(counting),
          (run) =>
            scoped(function* () {
              yield* registerComponents([
                plantObjectGraph(database, function* (workspace, checkout) {
                  yield* workspace.filesystem.remove(`${checkout}/.git/objects/pack`, {
                    recursive: true,
                    force: true,
                  });
                  yield* workspace.filesystem.symlink(
                    `${foreign.locator}/objects/pack`,
                    `${checkout}/.git/objects/pack`,
                  );
                }),
              ]);
              return yield* run();
            }),
        ),
      );

      expect(String(failure)).toContain("executed and published nothing");
      expect(String(failure)).not.toContain(foreign.locator);
      expect(subcommands(counting.counters)).not.toContain("ls-remote");
      expect(subcommands(counting.counters)).not.toContain("push");
      expect(yield* gitHostEvents(database)).toHaveLength(0);
      expect(publishedRoots(path)).toBe(3);
      expect(committedRoot(path)).toBe(latestRoot(path));
      expect(remoteRefs(remote).has(DESTINATION)).toBe(false);
    });
  });
});
