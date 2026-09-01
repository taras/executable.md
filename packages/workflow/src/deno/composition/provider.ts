/**
 * The Deno workflow Repository composition provider.
 *
 * This is the wiring: it installs the two profile Apis whose operations belong
 * to the two components' own modules. `repository.ts` and `worktree.ts` own what
 * a `<Repository>` and a `<Worktree>` respectively create and attach;
 * `effects.ts` owns the durable envelope both perform inside; `refusals.ts` owns
 * the words a refusal travels in; `identity.ts` owns holding a retained record
 * to the identity that names it.
 *
 * What is left here is the pairing of a creation with an attachment, the
 * translation between the profile-neutral selection a component observes and the
 * `RepositoryRecord` this run retains, and the one thing neither component can
 * do alone: hold the transaction open only for the export, so a Git subprocess
 * never keeps the run's database locked.
 *
 * ## Two halves per selection, and why
 *
 * **Creation** is one durable Workspace effect. A completed one restores from
 * the journal: replay reaches no remote, spawns no Git and imports nothing.
 *
 * **Attachment** is ephemeral and happens every time. It rebuilds the live
 * facade from the Workspace root the journal selected and proves the state the
 * record names is still there — which is what makes a partial replay safe to
 * continue from, and what discovers a checkout that has gone missing before any
 * child or later sibling begins.
 *
 * ## What a selection is worth here
 *
 * Nothing on its own. The record stays in this provider's closure, keyed by an
 * opaque identifier, and every Git operation asks the registry what the
 * selection it was handed names before it reads a row. A replaced contextual
 * Repository can therefore misname a checkout and be refused; it cannot reach
 * one. Answering `undefined` for the ambient Repository is the other half of
 * that: a workflow document names every repository it touches, so an element
 * written outside a `<Repository>` has none and its own refusal says so.
 */

import { type Operation } from "effection";
import { RepositoryComposition } from "../../composition/api.ts";
import type { RepositoryRequest, WorktreeRequest } from "../../composition/api.ts";
import { GitComposition } from "../../composition/git-api.ts";
import type {
  GitAddInvocation,
  GitCommitInvocation,
  GitPushInvocation,
  GitSwitchInvocation,
} from "../../composition/git-api.ts";
import type {
  GitAddResult,
  GitCommitResult,
  GitSwitchResult,
} from "../../composition/git-records.ts";
import type { GitPushOutcome } from "../../composition/git-push-records.ts";
import type { RepositoryRecord, WorktreeRecord } from "../../composition/records.ts";
import {
  filteredRepositoryIdentity,
  type RepositorySelection,
} from "../../composition/selection.ts";
import { GitOperationAuthorityError, RepositorySelectionError } from "../../composition/errors.ts";
import { selectionRegistry, type SelectionRegistry } from "../selections.ts";
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
  /**
   * The registry the Repository and Git installations share.
   *
   * They are installed as two calls and must resolve one selection: `<Git.Add>`
   * is handed what `<Repository>` minted. A caller that installs both passes the
   * same registry to both, which is what `withWorkflowWorkspace()` does.
   */
  readonly selections?: SelectionRegistry<RepositoryRecord>;
}

/** The registry both installations share, when a caller supplied none. */
export function workflowSelections(): SelectionRegistry<RepositoryRecord> {
  return selectionRegistry<RepositoryRecord>();
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

function hostOf(options: CompositionProviderOptions): RepositoryHost {
  return (
    options.host ??
    denoRepositoryHost({
      ...(options.authentication === undefined ? {} : { authentication: options.authentication }),
      ...(options.helper === undefined ? {} : { helper: options.helper }),
    })
  );
}

/**
 * A Git operation handed a selection this provider did not make.
 *
 * The same word `selectGitCheckout` uses for a Repository this run does not
 * retain, because it is the same condition reached one step earlier: what the
 * element observed does not name a checkout this run has.
 */
function unselected(operation: string): GitOperationAuthorityError {
  return new GitOperationAuthorityError(
    operation,
    "the Repository in scope is not one this run selected, so it names no retained checkout",
  );
}

/** The key a record is minted under: the whole creation identity, in order. */
function repositoryKey(record: RepositoryRecord): string {
  return [
    "repository",
    record.name,
    record.locatorFingerprint,
    record.requestedBase ?? "",
    record.creationCommit,
    record.primaryBranch,
    record.objectFormat,
    record.checkoutPath,
  ].join(" ");
}

function worktreeKey(record: WorktreeRecord): string {
  return [
    "worktree",
    record.repositoryName,
    record.name,
    record.requestedBranch,
    record.requestedBase ?? "",
    record.creationCommit,
    record.checkoutPath,
  ].join(" ");
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
  const host = hostOf(options);
  const observe = options.observe ?? {};
  const selections = options.selections ?? workflowSelections();

  return RepositoryComposition.around(
    {
      *selectRepository([request]: [RepositoryRequest]): Operation<RepositorySelection> {
        observe.effect?.("repository", request.name);
        const record = yield* createRepository(database, host, {
          name: request.name,
          locator: request.locator,
          base: request.base,
        });
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
        return selections.mint(
          repositoryKey(record),
          record.name,
          filteredRepositoryIdentity(record),
          record.checkoutPath,
          record,
        );
      },

      *selectWorktree([repository, request]: [
        RepositorySelection,
        WorktreeRequest,
      ]): Operation<RepositorySelection> {
        // The owner is this provider's own record for the selection it was
        // handed, never the selection's own words: a Worktree of a Repository
        // nobody selected is exactly what a replaced context would ask for.
        const owner = selections.authenticate(
          repository,
          () => new RepositorySelectionError("<Worktree>"),
        );
        observe.effect?.("worktree", request.name);
        const record = yield* createWorktree(database, host, {
          repositoryName: owner.name,
          name: request.name,
          branch: request.branch,
          base: request.base,
        });
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
        // The owner's identity, because that is the repository this checkout
        // belongs to, and the worktree's own name and path, because that is
        // which checkout of it this selection points at.
        return selections.mint(
          worktreeKey(record),
          record.name,
          filteredRepositoryIdentity(owner),
          record.checkoutPath,
          owner,
        );
      },

      // A workflow document names every repository it touches, so there is no
      // ambient one for an element written outside a `<Repository>` to mean.
      // `undefined` rather than a refusal: which component was written, and
      // what it needed a repository for, is the component's own sentence.
      // deno-lint-ignore require-yield
      *ambientRepository(): Operation<RepositorySelection | undefined> {
        return undefined;
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
 * attached, so ordinary `xmd run` reaches neither — it installs its own.
 */
export function useGitComposition(
  database: WorkflowRunDatabase,
  options: CompositionProviderOptions = {},
): Operation<void> {
  const host = hostOf(options);
  const observe = options.observe ?? {};
  const selections = options.selections ?? workflowSelections();

  return GitComposition.around(
    {
      *switchBranch([invocation]: [GitSwitchInvocation]): Operation<GitSwitchResult> {
        observe.effect?.("git", "switch");
        return yield* createGitSwitch(database, host, {
          repository: selections.authenticate(invocation.repository, () =>
            unselected("<Git.Switch>"),
          ),
          workingDirectory: invocation.workingDirectory,
          branch: invocation.branch,
          base: invocation.base,
        });
      },

      *addPaths([invocation]: [GitAddInvocation]): Operation<GitAddResult> {
        observe.effect?.("git", "add");
        return yield* createGitAdd(database, host, {
          repository: selections.authenticate(invocation.repository, () => unselected("<Git.Add>")),
          workingDirectory: invocation.workingDirectory,
          paths: invocation.paths,
        });
      },

      *commitIndex([invocation]: [GitCommitInvocation]): Operation<GitCommitResult> {
        observe.effect?.("git", "commit");
        return yield* createGitCommit(database, host, {
          repository: selections.authenticate(invocation.repository, () =>
            unselected("<Git.Commit>"),
          ),
          workingDirectory: invocation.workingDirectory,
          message: invocation.message,
          messageSource: invocation.messageSource,
        });
      },

      *pushCurrentBranch([invocation]: [GitPushInvocation]): Operation<GitPushOutcome> {
        observe.effect?.("git", "push");
        return yield* createGitPush(database, host, {
          repository: selections.authenticate(invocation.repository, () =>
            unselected("<Git.Push>"),
          ),
          workingDirectory: invocation.workingDirectory,
        });
      },
    },
    { at: "min" },
  );
}
