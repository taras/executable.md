/**
 * The envelope every transactional Git operation is performed inside.
 *
 * One expansion, one Workspace effect, one SQLite transaction — and inside that
 * transaction, one disposable materialization that native Git is allowed to see.
 * `<Git.Switch>` and the operations after it decide what Git does; everything
 * around that is here, because every one of them needs the same thing done in
 * the same order.
 *
 * ## Selection, before authority
 *
 * A document says which checkout it means by where it writes the element: the
 * enclosing `<Repository>` names the repository, the contextual working
 * directory names the checkout. Neither is trusted. The name is looked up in
 * this run's own retained rows, every row is held to the identity that names it,
 * and the working directory has to be exactly one of the checkout paths those
 * rows carry. A working directory that names none is a refusal — Git never runs,
 * and nothing is materialized — so a forged context selects nothing rather than
 * selecting something else.
 *
 * ## The whole family, every time
 *
 * The Repository and every Worktree it retains are materialized together, even
 * when the operation runs in only one of them. Git decides what a repository's
 * worktrees are by reading its own record of them, and it consults that record
 * to refuse a branch another checkout holds. A family exported in part would
 * answer that question wrongly, and the tree imported back would be missing a
 * checkout the run still holds.
 *
 * ## Verified before, evidence after
 *
 * Between materialization and native Git, the retained identity is proven
 * against what was exported: placement, origin, object format, creation commit,
 * and — for a linked worktree — that it really is a worktree of the Repository
 * it claims. Then the checkout's branch, commit, HEAD tree and index tree are
 * read, the operation runs, and they are read again. What the run retains is
 * those two readings rather than a summary of what changed, because a history
 * that says only "switched" cannot be checked against anything.
 */

import { scoped, type Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import type { GitCheckoutIdentity, GitCheckoutState } from "../../composition/git-records.ts";
import type { RepositoryRecord, WorktreeRecord } from "../../composition/records.ts";
import type { StoredRepository } from "../workspace/repositories.ts";
import {
  currentBranch,
  gitSession,
  headTree,
  indexTree,
  resolveCommit,
  type GitSession,
} from "./git.ts";
import type { RepositoryHost } from "./host.ts";
import {
  agreedStored,
  agreedWorktree,
  repositorySubject,
  stale,
  worktreeSubject,
  type Attached,
} from "./identity.ts";
import {
  exportTree,
  importTree,
  localizeAdministration,
  canonicalizeAdministration,
} from "./materialize.ts";
import { attempted, type CompositionOutcome, type MutationContext } from "./effects.ts";
import { gitRefused } from "./refusals.ts";
import { repositoryDisagreement } from "./repository.ts";
import { worktreeDisagreement } from "./worktree.ts";

/** What a component supplies about where its operation belongs. */
export interface GitOperationRequest {
  readonly repositoryName: string;
  /** The logical working directory the component observed. */
  readonly checkoutPath: string;
}

/** The materialized checkout one operation runs in. */
export interface GitCheckout {
  readonly git: GitSession;
  /** The real host directory this checkout was exported to. */
  readonly directory: string;
  /** The real host directory the Repository it belongs to was exported to. */
  readonly repositoryDirectory: string;
  readonly identity: GitCheckoutIdentity;
}

interface Selection {
  readonly repository: StoredRepository;
  readonly worktrees: readonly WorktreeRecord[];
  /** The Worktree this operation runs in, or `undefined` for the primary checkout. */
  readonly worktree: WorktreeRecord | undefined;
  readonly identity: GitCheckoutIdentity;
  readonly subject: string;
}

/**
 * Which retained checkout the name and the working directory select.
 *
 * Every row read here is held to the identity that names it before it is used
 * for anything, so a placement or a locator that no longer agrees is found
 * before a host path is joined and before Git exists in the story.
 */
function select(
  context: MutationContext,
  operation: string,
  request: GitOperationRequest,
): Selection {
  const repository = context.metadata.readRepository(request.repositoryName);
  if (repository === undefined) {
    gitRefused(operation, "not-a-checkout");
  }
  const repositorySubjectName = repositorySubject(request.repositoryName);
  agreedStored(repository, repositorySubjectName);

  const worktrees = context.metadata
    .readWorktreesForRepository(request.repositoryName)
    .map((worktree) => agreedWorktree(worktree, worktreeSubject(worktree.name)));

  if (request.checkoutPath === repository.record.checkoutPath) {
    return {
      repository,
      worktrees,
      worktree: undefined,
      identity: {
        repositoryName: repository.record.name,
        worktreeName: null,
        checkoutPath: repository.record.checkoutPath,
      },
      subject: repositorySubjectName,
    };
  }

  const worktree = worktrees.find((candidate) => candidate.checkoutPath === request.checkoutPath);
  if (worktree === undefined) {
    gitRefused(operation, "not-a-checkout");
  }
  return {
    repository,
    worktrees,
    worktree,
    identity: {
      repositoryName: repository.record.name,
      worktreeName: worktree.name,
      checkoutPath: worktree.checkoutPath,
    },
    subject: worktreeSubject(worktree.name),
  };
}

/** What the checkout holds right now, or the refusal that it holds nothing readable. */
function* checkoutState(
  git: GitSession,
  directory: string,
  operation: string,
): Operation<GitCheckoutState> {
  const branch = yield* currentBranch(git, directory);
  const commit = yield* resolveCommit(git, directory, "HEAD");
  const head = yield* headTree(git, directory);
  const index = yield* indexTree(git, directory);
  if (branch === undefined || commit === undefined || head === undefined || index === undefined) {
    gitRefused(operation, "unusable-repository");
  }
  return Object.freeze({ branch, commit, headTree: head, indexTree: index });
}

function* disagreement(
  git: GitSession,
  attached: Attached,
  record: RepositoryRecord,
  worktree: WorktreeRecord | undefined,
): Operation<void> {
  const found =
    worktree === undefined
      ? yield* repositoryDisagreement(git, attached, record.objectFormat, record.creationCommit)
      : yield* worktreeDisagreement(git, attached, worktree);
  if (found !== undefined) {
    const subject =
      worktree === undefined ? repositorySubject(record.name) : worktreeSubject(worktree.name);
    throw stale(subject, found);
  }
}

function runInCheckout<T>(
  context: MutationContext,
  host: RepositoryHost,
  operation: string,
  selection: Selection,
  perform: (checkout: GitCheckout, before: GitCheckoutState) => Operation<T>,
  describe: (
    checkout: GitCheckout,
    before: GitCheckoutState,
    after: GitCheckoutState,
    performed: T,
  ) => Json,
): Operation<Json> {
  const record = selection.repository.record;
  return scoped(function* () {
    const root = yield* host.useDirectory();
    const git = gitSession(host, root);

    const repositoryDirectory = yield* exportTree(
      context.filesystem,
      root,
      record.checkoutPath,
      repositorySubject(record.name),
    );
    // The selected checkout's own directory is taken from the export that
    // produced it rather than looked up afterwards: the two are the same string
    // by construction, and a lookup that could miss would need a fallback that
    // silently ran Git somewhere else.
    let directory = repositoryDirectory;
    const worktreeDirectories: string[] = [];
    for (const worktree of selection.worktrees) {
      const exported = yield* exportTree(
        context.filesystem,
        root,
        worktree.checkoutPath,
        worktreeSubject(worktree.name),
      );
      worktreeDirectories.push(exported);
      if (worktree === selection.worktree) {
        directory = exported;
      }
    }
    yield* localizeAdministration(
      root,
      repositoryDirectory,
      worktreeDirectories,
      selection.subject,
    );

    const checkout: GitCheckout = {
      git,
      directory,
      repositoryDirectory,
      identity: selection.identity,
    };

    yield* disagreement(
      git,
      { directory, repositoryDirectory, repository: record },
      record,
      selection.worktree,
    );

    const before = yield* checkoutState(git, directory, operation);
    const performed = yield* perform(checkout, before);
    const after = yield* checkoutState(git, directory, operation);

    yield* canonicalizeAdministration(
      root,
      repositoryDirectory,
      worktreeDirectories,
      selection.subject,
    );
    yield* importTree(context.filesystem, root, record.checkoutPath);
    for (const worktree of selection.worktrees) {
      yield* importTree(context.filesystem, root, worktree.checkoutPath);
    }

    return describe(checkout, before, after, performed);
  });
}

/**
 * Perform one Git operation as this run's next durable effect.
 *
 * The three ways it can end are the envelope's, not the operation's. A refusal
 * becomes the effect's failed durable outcome against a Workspace root that did
 * not move; a Workspace that could not retain what Git produced fails the run;
 * and a stale-state condition or a cancellation travels on untouched.
 */
export function* performGitOperation<T>(
  context: MutationContext,
  host: RepositoryHost,
  operation: string,
  request: GitOperationRequest,
  perform: (checkout: GitCheckout, before: GitCheckoutState) => Operation<T>,
  describe: (
    checkout: GitCheckout,
    before: GitCheckoutState,
    after: GitCheckoutState,
    performed: T,
  ) => Json,
): Operation<CompositionOutcome> {
  const selection = select(context, operation, request);
  return yield* attempted(
    "git",
    operation,
    selection.subject,
    runInCheckout(context, host, operation, selection, perform, describe),
  );
}
