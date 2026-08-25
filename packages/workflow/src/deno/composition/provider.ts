/**
 * The Deno-local Repository composition provider.
 *
 * This is the wiring: it installs one Api whose four operations belong to the
 * two components' own modules. `repository.ts` and `worktree.ts` own what a
 * `<Repository>` and a `<Worktree>` respectively create and attach;
 * `effects.ts` owns the durable envelope both perform inside; `refusals.ts`
 * owns the words a refusal travels in; `identity.ts` owns holding a retained
 * record to the identity that names it.
 *
 * What is left here is the pairing of a creation with an attachment, and the
 * one thing neither component can do alone: hold the transaction open only for
 * the export, so a Git subprocess never keeps the run's database locked.
 *
 * ## Two halves per component, and why
 *
 * **Creation** is one durable Workspace effect. A completed one restores from
 * the journal: replay reaches no remote, spawns no Git and imports nothing.
 *
 * **Attachment** is ephemeral and happens every time. It rebuilds the live
 * facade from the Workspace root the journal selected and proves the state the
 * record names is still there — which is what makes a partial replay safe to
 * continue from, and what discovers a checkout that has gone missing before any
 * child or later sibling begins.
 */

import { type Operation } from "effection";
import { RepositoryComposition } from "../../composition/api.ts";
import { GitComposition } from "../../composition/git-api.ts";
import type {
  GitAddRequest,
  GitAddResult,
  GitCommitRequest,
  GitCommitResult,
  GitSwitchRequest,
  GitSwitchResult,
} from "../../composition/git-records.ts";
import type { GitPushOutcome, GitPushRequest } from "../../composition/git-push-records.ts";
import type { RepositoryRecord, WorktreeRecord } from "../../composition/records.ts";
import type { WorkflowRunDatabase } from "../../storage/api.ts";
import { transactWorkspaceRoots } from "../workspace/private.ts";
import type { PrivateWorkspaceTransaction } from "../workspace/private.ts";
import { gitSession, type GitSession } from "./git.ts";
import { denoRepositoryHost, type RepositoryHost } from "./host.ts";
import type { GitAuthentication } from "./authentication.ts";
import type { HelperAssembly } from "./credential-helper.ts";
import { WORKSPACE_REPOSITORY, WORKSPACE_WORKTREE } from "./effects.ts";
import { stale, type Attached, type StaleReason } from "./identity.ts";
import {
  createRepository,
  prepareRepositoryAttachment,
  repositoryDisagreement,
} from "./repository.ts";
import { createWorktree, prepareWorktreeAttachment, worktreeDisagreement } from "./worktree.ts";

import { createGitSwitch } from "./switch.ts";
import { createGitAdd } from "./add.ts";
import { createGitCommit } from "./commit.ts";
import { createGitPush } from "./push.ts";

export { WORKSPACE_REPOSITORY, WORKSPACE_WORKTREE } from "./effects.ts";
export { WORKSPACE_GIT_SWITCH } from "./switch.ts";
export { WORKSPACE_GIT_ADD } from "./add.ts";
export { WORKSPACE_GIT_COMMIT } from "./commit.ts";

/**
 * What a provider may observe about itself, for suites that count.
 *
 * A claim that replay performs no effect and reaches no remote is only worth
 * making if something counted. This is how: the host counts Git invocations,
 * and the provider counts the effects and attachments it performed.
 */
export interface CompositionObserver {
  effect?: (kind: "repository" | "worktree" | "git", name: string) => void;
  attachment?: (kind: "repository" | "worktree", name: string) => void;
}

export interface CompositionProviderOptions {
  readonly host?: RepositoryHost;
  readonly observe?: CompositionObserver;
  /**
   * What the host lends a Git command that transports to a remote.
   *
   * Only reaches the default host: a suite that supplies its own `host` has
   * already replaced the thing an attachment would be attached to. Absent, the
   * default host uses the shipped ambient authentication, which is the invoking
   * user's SSH agent and standard Git credential helpers.
   */
  readonly authentication?: GitAuthentication;
  /**
   * How this host writes and starts its own credential helper.
   *
   * Stated by the runtime entrypoint rather than inferred here: whether this is
   * Deno source or a compiled binary, and which platform's launcher to write,
   * are facts about the program that is running.
   */
  readonly helper?: HelperAssembly;
}

/**
 * Rebuild a live checkout from the Workspace and prove it is the retained one.
 *
 * The transaction is held only for the export: Git runs afterwards, against
 * files, so a subprocess never keeps the run's database locked. Nothing here
 * writes, clones or repairs — a disagreement is reported and the Workspace is
 * left exactly as it was found.
 */
function* attach(
  database: WorkflowRunDatabase,
  host: RepositoryHost,
  subject: string,
  prepare: (workspace: PrivateWorkspaceTransaction, root: string) => Operation<Attached>,
  disagreement: (git: GitSession, attached: Attached) => Operation<StaleReason | undefined>,
): Operation<void> {
  const root = yield* host.useDirectory();
  const prepared = yield* transactWorkspaceRoots(database, (workspace) => prepare(workspace, root));
  if (!prepared.ok) {
    throw prepared.error;
  }

  const git: GitSession = gitSession(host, root);
  const found = yield* disagreement(git, prepared.value);
  if (found !== undefined) {
    throw stale(subject, found);
  }
}

/**
 * Install this run's Repository composition for the current scope and below.
 *
 * `{ at: "min" }` on the same terms as every other provider in a workflow run:
 * an outer host adapter would otherwise answer ahead of it.
 */
export function useRepositoryComposition(
  database: WorkflowRunDatabase,
  options: CompositionProviderOptions = {},
): Operation<void> {
  const host =
    options.host ??
    denoRepositoryHost({
      ...(options.authentication === undefined ? {} : { authentication: options.authentication }),
      ...(options.helper === undefined ? {} : { helper: options.helper }),
    });
  const observe = options.observe ?? {};

  return RepositoryComposition.around(
    {
      *createRepository([request]): Operation<RepositoryRecord> {
        observe.effect?.("repository", request.name);
        return yield* createRepository(database, host, request);
      },

      *attachRepository([record]): Operation<void> {
        observe.attachment?.("repository", record.name);
        yield* attach(
          database,
          host,
          `repository ${JSON.stringify(record.name)}`,
          (workspace, root) =>
            prepareRepositoryAttachment(
              workspace,
              root,
              record,
              `repository ${JSON.stringify(record.name)}`,
            ),
          (git, attached) =>
            repositoryDisagreement(git, attached, record.objectFormat, record.creationCommit),
        );
      },

      *createWorktree([request]): Operation<WorktreeRecord> {
        observe.effect?.("worktree", request.name);
        return yield* createWorktree(database, host, request);
      },

      *attachWorktree([record]): Operation<void> {
        observe.attachment?.("worktree", record.name);
        yield* attach(
          database,
          host,
          `worktree ${JSON.stringify(record.name)}`,
          (workspace, root) =>
            prepareWorktreeAttachment(
              workspace,
              root,
              record,
              `worktree ${JSON.stringify(record.name)}`,
            ),
          (git, attached) => worktreeDisagreement(git, attached, record),
        );
      },
    },
    { at: "min" },
  );
}

/**
 * Install this run's transactional Git operations for the current scope and
 * below.
 *
 * Separate from the composition provider above and installed beside it, because
 * they answer different questions: that one owns what a checkout *is*, and this
 * one owns what may be done to one. Both are installed only where a Workspace is
 * attached, so ordinary `xmd run` has neither.
 */
export function useGitComposition(
  database: WorkflowRunDatabase,
  options: CompositionProviderOptions = {},
): Operation<void> {
  const host =
    options.host ??
    denoRepositoryHost({
      ...(options.authentication === undefined ? {} : { authentication: options.authentication }),
      ...(options.helper === undefined ? {} : { helper: options.helper }),
    });
  const observe = options.observe ?? {};

  return GitComposition.around(
    {
      *switchBranch([request]: [GitSwitchRequest]): Operation<GitSwitchResult> {
        observe.effect?.("git", "switch");
        return yield* createGitSwitch(database, host, request);
      },

      *addPaths([request]: [GitAddRequest]): Operation<GitAddResult> {
        observe.effect?.("git", "add");
        return yield* createGitAdd(database, host, request);
      },

      *commitIndex([request]: [GitCommitRequest]): Operation<GitCommitResult> {
        observe.effect?.("git", "commit");
        return yield* createGitCommit(database, host, request);
      },

      *pushCurrentBranch([request]: [GitPushRequest]): Operation<GitPushOutcome> {
        observe.effect?.("git", "push");
        return yield* createGitPush(database, host, request);
      },
    },
    { at: "min" },
  );
}
