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
  remoteBranch,
  remoteRefs,
  useBareRemote,
} from "./support/git-remotes.ts";
import { transactWorkspaceRoots } from "../src/deno/workspace/private.ts";
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
import { publishedRoots } from "./support/replay.ts";

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

/** A well-formed Repository record naming a Repository nothing retains. */
const FORGED: RepositoryRecord = Object.freeze({
  name: "ghost",
  locatorFingerprint: "0".repeat(64),
  requestedBase: null,
  creationCommit: "0".repeat(40),
  primaryBranch: "main",
  objectFormat: "sha1",
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

  it("refuses a destination that holds another commit, without forcing it", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();
      const before = remoteBranch(remote, "release");

      const failure = yield* raised(
        runWorkflowDocument(
          database,
          document(
            remote.locator,
            `<Git.Switch branch="release" />`,
            `<File path="notes.md">`,
            "diverged",
            "</File>",
            `<Git.Add paths="notes.md" />`,
            `<Git.Commit message="diverge from the remote" as="commit" />`,
            `<Git.Push />`,
            "",
            LATER,
          ),
          countingOptions(counting),
        ),
      );

      expect(String(failure)).toContain("conflicts");
      // The remote is exactly what it was: nothing was forced, reset, merged or
      // rebased to make the push apply.
      expect(remoteBranch(remote, "release")).toBe(before);
      expect(subcommands(counting.counters)).not.toContain("push");

      const [outcome] = yield* gitHostOutcomes(database);
      expect(outcome?.status).toBe("err");
      expect(outcome?.name).toBe("GitHostConflictError");

      // A refusal changes no tracking either. `release` is a branch the remote
      // published, so switching to it established tracking the ordinary way;
      // what matters is that the refused push left exactly that and did not
      // repoint it.
      const configured = yield* checkoutConfig(database, yield* checkoutPath(database), [
        "branch.release.remote",
        "branch.release.merge",
      ]);
      expect(configured.get("branch.release.remote")).toBe("origin");
      expect(configured.get("branch.release.merge")).toBe("refs/heads/release");
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
