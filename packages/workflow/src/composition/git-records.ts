/**
 * What one transactional Git operation asks for, and what it retains.
 *
 * A Git operation is not identified by a path a document wrote. It runs in the
 * checkout the enclosing `<Repository>` and the contextual working directory
 * select, so what a component sends is the whole Repository record it observed
 * and the logical directory it observed — neither of which carries authority.
 * The provider authenticates both against what this run retained; a record that
 * is not the retained one, or a directory inside no retained checkout, is a
 * failure of authority rather than an outcome, and nothing is published for it.
 *
 * What comes back is evidence rather than a summary. The checkout the operation
 * ran in, and the branch, commit, HEAD tree and index tree the checkout held
 * before and after native Git ran: enough for a reader of the run's history to
 * say what moved, and enough for a later slice to reconcile against. Nothing
 * here holds a host path, a Git message, or the bytes of anything Git wrote.
 *
 * Every value is parsed on the way back in, exactly. A replayed result arrives
 * as whatever the journal holds, so these parsers are what decide it is a result
 * at all — and a value carrying more or fewer members than the protocol declares
 * is not a result this run wrote.
 */

import type { Json } from "@executablemd/durable-streams";
import { beneath, canonicalWorkspacePath, members, optionalText, text } from "./parse.ts";
import type { GitObjectFormat, RepositoryRecord } from "./records.ts";

/** Which retained checkout one Git operation ran in. */
export interface GitCheckoutIdentity {
  readonly repositoryName: string;
  /** The Worktree's name, or `null` when the operation ran in the primary checkout. */
  readonly worktreeName: string | null;
  /** The Workspace-relative path of that checkout. */
  readonly checkoutPath: string;
}

/** What the checkout held at one instant, as Git reported it. */
export interface GitCheckoutState {
  readonly branch: string;
  readonly commit: string;
  readonly headTree: string;
  readonly indexTree: string;
}

/**
 * What a `<Git.Switch>` invocation asks the provider to do.
 *
 * The Repository arrives whole rather than by name. A name alone can only be
 * looked up; the record can be *compared*, which is what lets the provider hold
 * a replaced context to the exact row this run retained rather than to whichever
 * Repository happens to answer to that name.
 *
 * The working directory is kept apart from the checkout throughout. A checkout
 * is what the operation belongs to; the working directory is where inside it the
 * element was written, and the two are equal only when a document wrote the
 * element at the checkout root.
 */
export interface GitSwitchRequest {
  readonly repository: RepositoryRecord;
  /** The logical working directory the component observed. */
  readonly workingDirectory: string;
  readonly branch: string;
  readonly base: string | undefined;
}

/**
 * What a completed `<Git.Switch>` retained.
 *
 * The requested branch beside the branch the checkout ended on, and the
 * requested base beside the commit it actually started from — `null` when the
 * branch already existed, because a base is consulted only when one has to be
 * created. Both halves are kept: what a document asked for and what Git did are
 * different facts, and a history holding only one of them cannot say which.
 */
export interface GitSwitchResult {
  readonly checkout: GitCheckoutIdentity;
  readonly requestedBranch: string;
  readonly resolvedBranch: string;
  readonly requestedBase: string | null;
  readonly resolvedBase: string | null;
  readonly before: GitCheckoutState;
  readonly after: GitCheckoutState;
}

const IDENTITY_MEMBERS = ["repositoryName", "worktreeName", "checkoutPath"] as const;

const STATE_MEMBERS = ["branch", "commit", "headTree", "indexTree"] as const;

const SWITCH_MEMBERS = [
  "checkout",
  "requestedBranch",
  "resolvedBranch",
  "requestedBase",
  "resolvedBase",
  "before",
  "after",
] as const;

/**
 * An object id in the algorithm this repository names its objects with.
 *
 * Length and case both, because a digest is a fixed-width lowercase hex string
 * everywhere Git writes one. A value that is merely a non-empty string is not an
 * object id, and treating one as an id is how a retained result that says
 * nothing passes for one that says something.
 */
function objectId(value: unknown, format: GitObjectFormat): string | undefined {
  const candidate = text(value);
  const width = format === "sha1" ? 40 : 64;
  return candidate !== undefined && new RegExp(`^[0-9a-f]{${width}}$`).test(candidate)
    ? candidate
    : undefined;
}

export function parseGitCheckoutIdentity(value: unknown): GitCheckoutIdentity | undefined {
  const record = members(value, IDENTITY_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  const repositoryName = text(record.repositoryName);
  const worktreeName = optionalText(record.worktreeName);
  const checkoutPath = canonicalWorkspacePath(record.checkoutPath);
  if (repositoryName === undefined || worktreeName === undefined || checkoutPath === undefined) {
    return undefined;
  }
  return Object.freeze({ repositoryName, worktreeName, checkoutPath });
}

export function parseGitCheckoutState(
  value: unknown,
  format: GitObjectFormat,
): GitCheckoutState | undefined {
  const record = members(value, STATE_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  const branch = text(record.branch);
  const commit = objectId(record.commit, format);
  const headTree = objectId(record.headTree, format);
  const indexTree = objectId(record.indexTree, format);
  if (
    branch === undefined ||
    commit === undefined ||
    headTree === undefined ||
    indexTree === undefined
  ) {
    return undefined;
  }
  return Object.freeze({ branch, commit, headTree, indexTree });
}

/**
 * What the invocation this result is being read for asked for.
 *
 * A result is read back for one request, and a result that does not describe
 * *that* request is not this invocation's result whatever else it is. Passing
 * the request in is what turns reading into checking: the identity, the branch,
 * the base and the transition are all compared rather than accepted.
 */
export interface GitSwitchExpectation {
  readonly repository: RepositoryRecord;
  readonly workingDirectory: string;
  readonly branch: string;
  readonly base: string | undefined;
}

/**
 * The switch result this value describes for this request, or `undefined`.
 *
 * Total, exact about membership, and closed about meaning. Beyond the shape it
 * refuses a result whose checkout is not the one the request selects, whose
 * branch or base is not the one the request asked for, and whose two readings do
 * not describe a switch: a created branch ends at the commit it was created
 * from and cannot be the branch the checkout was already on, and a checkout that
 * ends on the branch it began on cannot have moved — not its commit, not its
 * HEAD tree, and not its index.
 *
 * What it cannot decide is where a name is placed. A checkout path is a function
 * of identity, and whose function it is belongs to the provider, so the caller
 * holds the parsed identity to its own placement before using it.
 */
export function parseGitSwitchResult(
  value: unknown,
  expected: GitSwitchExpectation,
): GitSwitchResult | undefined {
  const record = members(value, SWITCH_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  const format = expected.repository.objectFormat;
  const checkout = parseGitCheckoutIdentity(record.checkout);
  const requestedBranch = text(record.requestedBranch);
  const resolvedBranch = text(record.resolvedBranch);
  const requestedBase = optionalText(record.requestedBase);
  const resolvedBase = record.resolvedBase === null ? null : objectId(record.resolvedBase, format);
  const before = parseGitCheckoutState(record.before, format);
  const after = parseGitCheckoutState(record.after, format);
  if (
    checkout === undefined ||
    requestedBranch === undefined ||
    resolvedBranch === undefined ||
    requestedBase === undefined ||
    resolvedBase === undefined ||
    before === undefined ||
    after === undefined
  ) {
    return undefined;
  }

  if (
    checkout.repositoryName !== expected.repository.name ||
    !beneath(checkout.checkoutPath, expected.workingDirectory) ||
    (checkout.worktreeName === null &&
      checkout.checkoutPath !== expected.repository.checkoutPath) ||
    (checkout.worktreeName !== null && checkout.checkoutPath === expected.repository.checkoutPath)
  ) {
    return undefined;
  }

  if (
    requestedBranch !== expected.branch ||
    requestedBase !== (expected.base ?? null) ||
    resolvedBranch !== expected.branch ||
    after.branch !== resolvedBranch
  ) {
    return undefined;
  }

  const created = resolvedBase !== null;
  if (created && (after.commit !== resolvedBase || before.branch === after.branch)) {
    return undefined;
  }
  // Switching to the branch a checkout is already on moves nothing: no reset,
  // no reference change, and nothing staged or unstaged. A retained result whose
  // commit, HEAD tree or index tree changed across it describes a transition
  // Switch does not make.
  if (
    !created &&
    before.branch === after.branch &&
    (before.commit !== after.commit ||
      before.headTree !== after.headTree ||
      before.indexTree !== after.indexTree)
  ) {
    return undefined;
  }

  return Object.freeze({
    checkout,
    requestedBranch,
    resolvedBranch,
    requestedBase,
    resolvedBase,
    before,
    after,
  });
}

export function gitCheckoutIdentityJson(identity: GitCheckoutIdentity): Json {
  return {
    repositoryName: identity.repositoryName,
    worktreeName: identity.worktreeName,
    checkoutPath: identity.checkoutPath,
  };
}

export function gitCheckoutStateJson(state: GitCheckoutState): Json {
  return {
    branch: state.branch,
    commit: state.commit,
    headTree: state.headTree,
    indexTree: state.indexTree,
  };
}

export function gitSwitchResultJson(result: GitSwitchResult): Json {
  return {
    checkout: gitCheckoutIdentityJson(result.checkout),
    requestedBranch: result.requestedBranch,
    resolvedBranch: result.resolvedBranch,
    requestedBase: result.requestedBase,
    resolvedBase: result.resolvedBase,
    before: gitCheckoutStateJson(result.before),
    after: gitCheckoutStateJson(result.after),
  };
}
