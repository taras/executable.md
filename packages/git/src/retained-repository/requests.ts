/**
 * The external requests one entry freezes before it contacts a service.
 *
 * Push, a pull-request upsert and an issue upsert are the three operations
 * whose answer lives somewhere this journal does not reach, and all three are
 * named by what they ask rather than by what they changed. That naming is the
 * whole problem these records solve: the ask is partly *resolved* — the branch
 * the checkout is on, the commit it holds, the repository identity its
 * selection pinned — and resolving it again on a later open asks a different
 * question, which would consume no retained result and repeat the effect.
 *
 * So the resolved request is written down, once, before anything is contacted,
 * and a later open reads it back instead of resolving it again. What makes that
 * safe is the operation each one is: none of the three changes the checkout it
 * was written in, so the state the record freezes at both ends is one state,
 * and the record pair is complete before the service is touched.
 *
 * These are the frozen *inputs*. What the service answered stays where it
 * already is — in the existing `git_host_effect` and `issue_effect` records —
 * because two authorities for one outcome is exactly how a journal comes to
 * hold two answers to one question.
 */

import type { Json } from "@executablemd/durable-streams";
import { members, text } from "../composition/parse.ts";
import {
  gitPushInputsJson,
  parseGitPushInputs,
  type GitPushInputs,
} from "../composition/git-push-records.ts";
import {
  parsePullRequestInputs,
  pullRequestInputsJson,
  type PullRequestInputs,
} from "../composition/pull-request-records.ts";
import { issueInputJson, parseIssueInput } from "../issue/records.ts";
import { parseRepositoryIdentity, repositoryIdentityJson } from "../composition/selection.ts";
import type { RepositoryIdentity } from "../composition/selection.ts";
import type { IssueInput } from "../issue/api.ts";

/** The kind each frozen request names itself by, as its evidence spells it. */
const PUSH = "push";
const PULL_REQUEST = "pull-request";
const ISSUE = "issue";

const PUSH_MEMBERS = ["type", "checkout", "origin", "inputs"] as const;
const PULL_REQUEST_MEMBERS = ["type", "checkout", "origin", "inputs"] as const;
const ISSUE_MEMBERS = ["type", "target", "provider", "issue"] as const;

/**
 * One frozen `<Git.Push>`: which checkout, to which origin, publishing what.
 *
 * The checkout is here and not in the Git-host request because the Git-host
 * request deliberately carries no host path — and because which checkout of a
 * repository an entry published from is what a later pull request has to
 * match. The origin is the credential-free locator the selection admitted.
 */
export interface RetainedPushRequest {
  readonly checkout: string;
  readonly origin: string;
  readonly inputs: GitPushInputs;
}

export function retainedPushRequestJson(request: RetainedPushRequest): Json {
  return {
    type: PUSH,
    checkout: request.checkout,
    origin: request.origin,
    inputs: gitPushInputsJson(request.inputs),
  };
}

/** The frozen push this value describes, or `undefined` when it describes none. */
export function parseRetainedPushRequest(value: unknown): RetainedPushRequest | undefined {
  const read = members(value, PUSH_MEMBERS);
  if (read === undefined || read["type"] !== PUSH) {
    return undefined;
  }
  const checkout = text(read["checkout"]);
  const origin = text(read["origin"]);
  const inputs = parseGitPushInputs(read["inputs"]);
  if (checkout === undefined || origin === undefined || inputs === undefined) {
    return undefined;
  }
  return Object.freeze({ checkout, origin, inputs });
}

/** One frozen `<PullRequest>`: the whole upsert, including the head it names. */
export interface RetainedPullRequestRequest {
  readonly checkout: string;
  readonly origin: string;
  readonly inputs: PullRequestInputs;
}

export function retainedPullRequestRequestJson(request: RetainedPullRequestRequest): Json {
  return {
    type: PULL_REQUEST,
    checkout: request.checkout,
    origin: request.origin,
    inputs: pullRequestInputsJson(request.inputs),
  };
}

export function parseRetainedPullRequestRequest(
  value: unknown,
): RetainedPullRequestRequest | undefined {
  const read = members(value, PULL_REQUEST_MEMBERS);
  if (read === undefined || read["type"] !== PULL_REQUEST) {
    return undefined;
  }
  const checkout = text(read["checkout"]);
  const origin = text(read["origin"]);
  const inputs = parsePullRequestInputs(read["inputs"]);
  if (checkout === undefined || origin === undefined || inputs === undefined) {
    return undefined;
  }
  return Object.freeze({ checkout, origin, inputs });
}

/**
 * One frozen `<Issue>` upsert: the destination, the discriminator and the text.
 *
 * Nothing here is resolved from live state — a document wrote all of it — so
 * what this record adds is the barrier rather than the inputs: it says this
 * entry asked for this issue at this site before any tracker was contacted.
 */
export interface RetainedIssueRequest {
  readonly target: string;
  readonly provider: string | null;
  readonly issue: IssueInput;
}

export function retainedIssueRequestJson(request: RetainedIssueRequest): Json {
  return {
    type: ISSUE,
    target: request.target,
    provider: request.provider,
    issue: issueInputJson(request.issue),
  };
}

export function parseRetainedIssueRequest(value: unknown): RetainedIssueRequest | undefined {
  const read = members(value, ISSUE_MEMBERS);
  if (read === undefined || read["type"] !== ISSUE) {
    return undefined;
  }
  const target = text(read["target"]);
  // One spelling of absence, as the request carries it.
  const provider = read["provider"] === null ? null : text(read["provider"]);
  const issue = parseIssueInput(read["issue"]);
  if (target === undefined || provider === undefined || issue === undefined) {
    return undefined;
  }
  return Object.freeze({ target, provider, issue });
}

/**
 * What an ambient selection resolved about the checkout it found.
 *
 * The root alone would not be enough to publish from later. A repository's
 * identity includes the commit it was selected at and the branch a pull request
 * defaults its base to, and both are read from the checkout when it is
 * discovered — so an entry that selects a checkout, commits in it and then
 * pushes would, on a later open, derive an identity naming its own new commit
 * and ask a question its history never recorded. The resolved identity is
 * therefore part of what the selection freezes, and a resume reads it back.
 */
export interface RetainedAmbientSelection {
  /** The canonical checkout root this entry works in. */
  readonly root: string;
  readonly identity: RepositoryIdentity;
  /** The credential-free origin it publishes to, or `null` when it has none. */
  readonly origin: string | null;
}

const AMBIENT_MEMBERS = ["root", "identity", "origin"] as const;

export function retainedAmbientSelectionJson(selection: RetainedAmbientSelection): Json {
  return {
    root: selection.root,
    identity: repositoryIdentityJson(selection.identity),
    origin: selection.origin,
  };
}

export function parseRetainedAmbientSelection(
  value: unknown,
): RetainedAmbientSelection | undefined {
  const read = members(value, AMBIENT_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const root = text(read["root"]);
  const identity = parseRepositoryIdentity(read["identity"]);
  const origin = read["origin"] === null ? null : text(read["origin"]);
  if (root === undefined || identity === undefined || origin === undefined) {
    return undefined;
  }
  return Object.freeze({ root, identity, origin });
}
