/**
 * The envelope every transactional Git operation is performed inside.
 *
 * One expansion, one Workspace effect, one SQLite transaction — and inside that
 * transaction, one disposable materialization that native Git is allowed to see.
 * `<Git.Switch>` and the operations after it decide what Git does; everything
 * around that is here, because every one of them needs the same thing done in
 * the same order.
 *
 * ## Authority, before anything
 *
 * A document says which checkout it means by where it writes the element: the
 * enclosing `<Repository>` supplies the record, the contextual working directory
 * supplies the place. Neither is trusted. The record is compared member for
 * member against the row this run retained under that name, every retained row
 * is held to the identity that names it, and the working directory has to be a
 * place inside one of the checkouts those rows carry.
 *
 * A failure of any of that is not an outcome. Nobody asked for a checkout that
 * is not there, and a document cannot avoid a record that stopped matching, so
 * these fail the run rather than publishing a Git result that says an operation
 * happened. Git never runs, nothing is materialized, and no history is written.
 *
 * ## The checkout and the place inside it are different things
 *
 * A checkout is what the operation belongs to; the working directory is where
 * inside it the element was written. `<Dir path="packages/core">` inside a
 * Repository still operates on that Repository — it is where Git runs, not what
 * Git runs on. So the two travel separately: identity comes from the retained
 * row, and the place is the retained checkout's own path with the rest of the
 * directory joined onto it, proven to be a real directory inside the export
 * before any command is given it.
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

import { scoped, type Operation, until } from "effection";
import { lstat } from "@effectionx/fs";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { realpath } from "node:fs/promises";
import type { Json } from "@executablemd/durable-streams";
import type { GitCheckoutIdentity, GitCheckoutState } from "../../composition/git-records.ts";
import {
  sameRepositoryRecord,
  type RepositoryRecord,
  type WorktreeRecord,
} from "../../composition/records.ts";
import { beneath, canonicalWorkspacePath } from "../../composition/parse.ts";
import {
  GitOperationAuthorityError,
  GitOperationInfrastructureError,
} from "../../composition/errors.ts";
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
import { repositoryDisagreement } from "./repository.ts";
import { worktreeDisagreement } from "./worktree.ts";

/**
 * The digest one Git operation's durable identity is built from.
 *
 * Injective, because the values it covers include a whole retained record and a
 * document's own strings, and durable identity is what decides whether a
 * recorded result may be handed back for an invocation. Two different
 * observations that digested alike would let a replay return a transition
 * authorized for one of them to the other — without the live path, where the
 * observation is authenticated, ever running.
 *
 * So each value is length-prefixed rather than joined by a separator, and
 * absence is a marker no encoded value can produce. Any character may appear in
 * a branch, a base, a name or a path — including the ones a separator scheme
 * would reserve — and a length prefix says exactly how much of what follows
 * belongs to this value, so no arrangement of values can be read as another.
 *
 * This is deliberately its own encoding rather than a change to
 * `fingerprintOf()`, whose digests are already part of retained Repository and
 * Worktree identity in this run's history.
 */
export function gitOperationFingerprint(values: readonly (string | null)[]): string {
  const canonical = values
    .map((value) => (value === null ? "-" : `${value.length}:${value}`))
    .join("");
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
}

/** What a component supplies about where its operation belongs. */
export interface GitOperationRequest {
  /** The whole Repository record the component observed, to be compared. */
  readonly repository: RepositoryRecord;
  /** The logical working directory the component observed. */
  readonly workingDirectory: string;
}

/** The materialized checkout one operation runs in. */
export interface GitCheckout {
  readonly git: GitSession;
  /** The real host directory this checkout was exported to. */
  readonly directory: string;
  /** The real host directory the Repository it belongs to was exported to. */
  readonly repositoryDirectory: string;
  /**
   * The real host directory the element was written in.
   *
   * The checkout's own directory when the element was written at its root, and a
   * directory inside it otherwise. This is where a command runs; `directory` is
   * what it runs on.
   */
  readonly workingDirectory: string;
  readonly identity: GitCheckoutIdentity;
}

interface Selection {
  readonly repository: StoredRepository;
  readonly worktrees: readonly WorktreeRecord[];
  /** The Worktree this operation runs in, or `undefined` for the primary checkout. */
  readonly worktree: WorktreeRecord | undefined;
  readonly identity: GitCheckoutIdentity;
  /** What the working directory adds to the checkout's own path, or `""`. */
  readonly within: string;
  readonly subject: string;
}

function unauthorized(operation: string, reason: string): never {
  throw new GitOperationAuthorityError(operation, reason);
}

/**
 * Which retained checkout the observed Repository and working directory select.
 *
 * Every row read here is held to the identity that names it before it is used
 * for anything, so a placement or a locator that no longer agrees is found
 * before a host path is joined and before Git exists in the story. The observed
 * record is then compared with the retained one member for member: a name can
 * only be looked up, and looking one up is what a replaced context would rely
 * on.
 */
function select(
  context: MutationContext,
  operation: string,
  request: GitOperationRequest,
): Selection {
  const observed = request.repository;
  const stored = context.metadata.readRepository(observed.name);
  if (stored === undefined) {
    unauthorized(operation, "this run retains no Repository under the name it was given");
  }
  const repositorySubjectName = repositorySubject(observed.name);
  agreedStored(stored, repositorySubjectName);
  if (!sameRepositoryRecord(stored.record, observed)) {
    unauthorized(
      operation,
      "the Repository it observed is not the one this run retained under that name",
    );
  }

  const worktrees = context.metadata
    .readWorktreesForRepository(observed.name)
    .map((worktree) => agreedWorktree(worktree, worktreeSubject(worktree.name)));

  const directory = canonicalWorkspacePath(request.workingDirectory);
  if (directory === undefined) {
    unauthorized(operation, "its working directory does not name one place in the Workspace");
  }

  // The longest match rather than the first: a checkout nested inside another
  // one is the checkout its own paths belong to. Placement keeps worktrees out
  // of the Repository's tree, so this is a proof rather than a preference.
  const worktree = worktrees
    .filter((candidate) => beneath(candidate.checkoutPath, directory))
    .sort((left, right) => right.checkoutPath.length - left.checkoutPath.length)[0];
  const checkout =
    worktree === undefined
      ? beneath(stored.record.checkoutPath, directory)
        ? stored.record.checkoutPath
        : undefined
      : worktree.checkoutPath;
  if (checkout === undefined) {
    unauthorized(
      operation,
      "its working directory is not inside any checkout this run retains for that Repository",
    );
  }

  return {
    repository: stored,
    worktrees,
    worktree,
    identity: {
      repositoryName: stored.record.name,
      worktreeName: worktree === undefined ? null : worktree.name,
      checkoutPath: checkout,
    },
    within: directory.slice(checkout.length),
    subject: worktree === undefined ? repositorySubjectName : worktreeSubject(worktree.name),
  };
}

/**
 * What the checkout holds right now.
 *
 * A checkout this run retains, verified moments earlier, that cannot answer
 * where its branch, its commit or its trees are is not a condition a document
 * asked for. It is infrastructure, and publishing it as an outcome would record
 * a transition nobody can describe.
 */
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
    throw new GitOperationInfrastructureError(
      operation,
      "the checkout it ran in did not report the branch, commit and trees it holds",
    );
  }
  return Object.freeze({ branch, commit, headTree: head, indexTree: index });
}

/**
 * The real directory inside the export the element was written in.
 *
 * Proven rather than assumed, at the one place the retained path and the host
 * root are joined. The checkout root already resolves to itself; what is added
 * here is the rest of the working directory, which may name anything a checkout
 * contains — including a tracked symbolic link, which the operating system would
 * resolve before Git ever reported where it was running.
 */
function* workingDirectoryOf(
  checkout: string,
  within: string,
  operation: string,
): Operation<string> {
  const directory = `${checkout}${within}`;
  if (within === "") {
    return directory;
  }
  const info = yield* entry(directory);
  if (info === undefined || !info.isDirectory()) {
    unauthorized(operation, "its working directory is not a directory in the checkout it selected");
  }
  // `lstat` says the entry itself is not a link; this says no segment above it
  // is either. The operating system resolves a working directory before Git
  // sees it, so a link anywhere along the way would run every command somewhere
  // this run does not own.
  if ((yield* until(realpath(directory))) !== directory) {
    unauthorized(
      operation,
      "its working directory does not resolve to a place inside the checkout it selected",
    );
  }
  return directory;
}

/**
 * What the host holds at this path, or `undefined` when it holds nothing there.
 *
 * `lstat` rather than `stat`, so a symbolic link answers as itself. Absence is
 * keyed on the code rather than on a runtime's own error class, so this reads
 * the same wherever the adapter runs.
 */
function* entry(path: string): Operation<Stats | undefined> {
  try {
    return yield* lstat(path);
  } catch (error) {
    const code = error instanceof Error ? Reflect.get(error, "code") : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
}

/**
 * That the exported checkout is still the one the retained record names.
 *
 * Creation identity, read back out of the bytes: where it came from, how it
 * names objects, the commit it was created at, and — for a linked worktree —
 * that it is a worktree of the Repository it belongs to. A disagreement is stale
 * retained state, which is fatal: nothing published, nothing repaired.
 */
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
      workingDirectory: yield* workingDirectoryOf(directory, selection.within, operation),
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
