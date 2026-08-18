/**
 * What one transactional Git operation asks for, and what it retains.
 *
 * A Git operation is not identified by a path a document wrote. It runs in the
 * checkout the enclosing `<Repository>` and the contextual working directory
 * select, so what a component sends is a Repository name and the logical
 * directory it observed — neither of which carries authority. Which retained
 * checkout those two select, and whether they select one at all, is the
 * provider's answer.
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
import { members, optionalText, text } from "./parse.ts";

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

/** What a `<Git.Switch>` invocation asks the provider to do. */
export interface GitSwitchRequest {
  readonly repositoryName: string;
  /** The logical working directory the component observed. */
  readonly checkoutPath: string;
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

export function parseGitCheckoutIdentity(value: unknown): GitCheckoutIdentity | undefined {
  const record = members(value, IDENTITY_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  const repositoryName = text(record.repositoryName);
  const worktreeName = optionalText(record.worktreeName);
  const checkoutPath = text(record.checkoutPath);
  if (
    repositoryName === undefined ||
    worktreeName === undefined ||
    checkoutPath === undefined ||
    !checkoutPath.startsWith("/")
  ) {
    return undefined;
  }
  return Object.freeze({ repositoryName, worktreeName, checkoutPath });
}

export function parseGitCheckoutState(value: unknown): GitCheckoutState | undefined {
  const record = members(value, STATE_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  const branch = text(record.branch);
  const commit = text(record.commit);
  const headTree = text(record.headTree);
  const indexTree = text(record.indexTree);
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

export function parseGitSwitchResult(value: unknown): GitSwitchResult | undefined {
  const record = members(value, SWITCH_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  const checkout = parseGitCheckoutIdentity(record.checkout);
  const requestedBranch = text(record.requestedBranch);
  const resolvedBranch = text(record.resolvedBranch);
  const requestedBase = optionalText(record.requestedBase);
  const resolvedBase = optionalText(record.resolvedBase);
  const before = parseGitCheckoutState(record.before);
  const after = parseGitCheckoutState(record.after);
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
