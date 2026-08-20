/**
 * What one `<Issue>` asks for, and what its reconciliation retains.
 *
 * An issue is a collaboration object a Git host owns, so the effect is
 * reconciled through the shared Git-host state machine rather than committed
 * with a Workspace transaction — and what travels through that boundary is JSON
 * a provider in another package receives and a journal in this one keeps. None
 * of it is this module's word by the time it is read back, so every value is
 * parsed exactly.
 *
 * ## The resource is the obligation, not the text
 *
 * A deferred obligation is one thing however often a workflow runs, so the
 * natural key is what identifies the obligation and nothing else: the
 * Repository this issue lives in, the pull request the deferral was decided
 * against, and the finding's own identifier.
 *
 * ```text
 * { repository, pullRequestIdentity, finding }
 * ```
 *
 * The pull request travels there as the provider's own stable identity for it
 * rather than as its number, because a number is a fact about a host's
 * numbering and the identity is a fact about the pull request. The complete
 * request fingerprint still covers every input — title, evidence, rationale,
 * dependency impact, intended timing, disposition and the whole retained
 * PullRequest evidence — so changed text diverges at the durable position
 * rather than consuming the result retained for another question.
 *
 * ## The marker is the key, written where a Git host can be searched by it
 *
 * A Git host has nowhere to keep this run's natural key, so the key is written
 * into the issue body as one origin marker and searched for there. It is the
 * key's own digest, which is what makes "this issue carries our marker" and
 * "this issue is about our Repository, our pull request and our finding" the
 * same statement rather than two that could disagree.
 *
 * ## The result is what the reconciliation settled on
 *
 * What a document binds is the issue this effect left behind: the provider's
 * stable identity for it, its number, its URL, the pull request it records and
 * the finding it is about. Comments, labels, reactions and later edits are
 * separate reads. A retained record that re-read them would be answering a
 * different question every time it replayed.
 */

import { canonicalFingerprint } from "@executablemd/core";
import type { Json } from "@executablemd/durable-streams";
import type {
  GitHostDecision,
  GitHostEffectIdentity,
  GitHostReconciliationRecord,
} from "../git-host/records.ts";
import { members, text } from "./parse.ts";
import {
  gitPushRepositoryIdentityJson,
  parseGitPushRepositoryIdentity,
  sameRepositoryIdentity,
  type GitPushRepositoryIdentity,
} from "./git-push-records.ts";
import {
  parsePullRequestEvidence,
  pullRequestNumber,
  pullRequestResultJson,
  samePullRequestEvidence,
  type PullRequestResult,
} from "./pull-request-records.ts";
import type { RepositoryRecord } from "./records.ts";

/** The Git-host effect kind one issue is reconciled under. */
export const ISSUE = "issue";

/** The one state an issue this effect settles on is in. */
export const OPEN = "open";

/** The one disposition that records anything anywhere. */
export const DEFER = "defer";

/**
 * What the document decided about the finding.
 *
 * A closed word rather than free text, because it is what decides whether
 * anything is published at all. Three of the four are decisions that leave no
 * trace outside the document, and the fourth is the one this element exists for.
 */
export type IssueDisposition = "defer" | "rejected" | "fix-now" | "inserted-repair";

const DISPOSITIONS: readonly string[] = Object.freeze([
  DEFER,
  "rejected",
  "fix-now",
  "inserted-repair",
]);

/** The disposition this word is, or `undefined` when it is not one of them. */
export function parseIssueDisposition(value: unknown): IssueDisposition | undefined {
  if (value === DEFER) {
    return DEFER;
  }
  if (value === "rejected" || value === "fix-now" || value === "inserted-repair") {
    return value;
  }
  return undefined;
}

/** The four words a document may write, for a refusal that names them. */
export function issueDispositions(): readonly string[] {
  return DISPOSITIONS;
}

/** What an `<Issue>` invocation asks the provider to do. */
export interface IssueRequest {
  /** The whole Repository record the component observed, to be compared. */
  readonly repository: RepositoryRecord;
  /** The logical working directory the component observed. */
  readonly workingDirectory: string;
  /** The obligation's own identifier, as the document names it. */
  readonly finding: string;
  /** Only a deferral reaches a provider, and the request says so. */
  readonly disposition: "defer";
  /** The stable evidence this run's own `<PullRequest>` produced. */
  readonly pullRequest: PullRequestResult;
  readonly title: string;
  readonly rationale: string;
  readonly dependencyImpact: string;
  readonly intendedTiming: string;
  /** The rendered invocation content, verbatim. Empty content is `""`. */
  readonly body: string;
}

/** The filtered inputs one issue reconciliation acts on. */
export interface IssueInputs {
  readonly repository: GitPushRepositoryIdentity;
  readonly pullRequest: PullRequestResult;
  readonly finding: string;
  readonly disposition: "defer";
  readonly title: string;
  readonly body: string;
  readonly rationale: string;
  readonly dependencyImpact: string;
  readonly intendedTiming: string;
}

/** What the provider looks one issue up by: the obligation it records. */
export interface IssueNaturalKey {
  readonly repository: GitPushRepositoryIdentity;
  /** The provider's own stable identity for the pull request. */
  readonly pullRequestIdentity: string;
  readonly finding: string;
}

/** One open issue, normalized away from whatever a provider calls it. */
export interface IssueSnapshot {
  /** The provider's own stable identity for this issue. */
  readonly providerId: string;
  readonly number: number;
  readonly url: string;
  readonly state: "open";
  readonly title: string;
  readonly body: string;
}

/**
 * What the Git host held for this resource before this attempt.
 *
 * `null` only where nothing was there. An issue about to be updated has a
 * pre-state — the issue as it was before the update — and that is what makes a
 * performed update describable at all.
 */
export interface IssuePreState {
  readonly issue: IssueSnapshot | null;
}

/** The issue this effect finished at, observed after everything it did. */
export interface IssueObservations {
  readonly issue: IssueSnapshot;
}

/** The pull request an issue result names, filtered to what a reader acts on. */
export interface IssuePullRequestReference {
  readonly number: number;
  readonly url: string;
}

/** What a reconciled issue retains, and what a document binds. */
export interface IssueResult {
  readonly repository: GitPushRepositoryIdentity;
  readonly pullRequest: IssuePullRequestReference;
  readonly providerId: string;
  readonly number: number;
  readonly url: string;
  readonly state: "open";
  readonly finding: string;
}

/** One reconciled issue: what the shared engine decided, and what it retains. */
export interface IssueOutcome {
  readonly decision: GitHostDecision;
  readonly result: IssueResult;
}

/**
 * What a retained issue record is read back for.
 *
 * The complete admitted inputs, because every one of them is something the
 * record has to agree with: the resource it names, the pull request it was
 * settled against, and the text the final snapshot has to hold.
 */
export type IssueExpectation = IssueInputs;

const INPUT_MEMBERS = [
  "repository",
  "pullRequest",
  "finding",
  "disposition",
  "title",
  "body",
  "rationale",
  "dependencyImpact",
  "intendedTiming",
] as const;

const KEY_MEMBERS = ["repository", "pullRequestIdentity", "finding"] as const;

const SNAPSHOT_MEMBERS = ["providerId", "number", "url", "state", "title", "body"] as const;

const PRE_STATE_MEMBERS = ["issue"] as const;

const OBSERVATION_MEMBERS = ["issue"] as const;

const REFERENCE_MEMBERS = ["number", "url"] as const;

const RESULT_MEMBERS = [
  "repository",
  "pullRequest",
  "providerId",
  "number",
  "url",
  "state",
  "finding",
] as const;

/**
 * An issue number, as a number rather than as something numeric.
 *
 * The same closed reading a pull-request number gets, and for the same reason:
 * a float, a negative and a numeric string are all values a provider could put
 * here, and reading one as a number would name an issue nothing has.
 */
export function issueNumber(value: unknown): number | undefined {
  return pullRequestNumber(value);
}

/** Text that may be empty and may not be absent. */
function bodyText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function issueInputsJson(inputs: IssueInputs): Json {
  return {
    repository: gitPushRepositoryIdentityJson(inputs.repository),
    pullRequest: pullRequestResultJson(inputs.pullRequest),
    finding: inputs.finding,
    disposition: inputs.disposition,
    title: inputs.title,
    body: inputs.body,
    rationale: inputs.rationale,
    dependencyImpact: inputs.dependencyImpact,
    intendedTiming: inputs.intendedTiming,
  };
}

export function issueNaturalKeyJson(key: IssueNaturalKey): Json {
  return {
    repository: gitPushRepositoryIdentityJson(key.repository),
    pullRequestIdentity: key.pullRequestIdentity,
    finding: key.finding,
  };
}

export function issueSnapshotJson(snapshot: IssueSnapshot): Json {
  return {
    providerId: snapshot.providerId,
    number: snapshot.number,
    url: snapshot.url,
    state: snapshot.state,
    title: snapshot.title,
    body: snapshot.body,
  };
}

export function issuePreStateJson(preState: IssuePreState): Json {
  return { issue: preState.issue === null ? null : issueSnapshotJson(preState.issue) };
}

export function issueObservationsJson(observations: IssueObservations): Json {
  return { issue: issueSnapshotJson(observations.issue) };
}

export function issueResultJson(result: IssueResult): Json {
  return {
    repository: gitPushRepositoryIdentityJson(result.repository),
    pullRequest: { number: result.pullRequest.number, url: result.pullRequest.url },
    providerId: result.providerId,
    number: result.number,
    url: result.url,
    state: result.state,
    finding: result.finding,
  };
}

/**
 * What a document binds for a reconciled issue: the result, and the decision.
 *
 * The decision lives beside the result rather than inside it. What one attempt
 * decided is the reconciliation record's own member, and a copy of it in the
 * retained result would be a second place for it to be written and a second
 * place for it to disagree.
 */
export function issueBindingJson(outcome: IssueOutcome): Json {
  return {
    repository: gitPushRepositoryIdentityJson(outcome.result.repository),
    pullRequest: {
      number: outcome.result.pullRequest.number,
      url: outcome.result.pullRequest.url,
    },
    providerId: outcome.result.providerId,
    number: outcome.result.number,
    url: outcome.result.url,
    state: outcome.result.state,
    finding: outcome.result.finding,
    decision: outcome.decision,
  };
}

/** The natural key these admitted inputs describe. */
export function issueNaturalKey(inputs: IssueInputs): IssueNaturalKey {
  return Object.freeze({
    repository: inputs.repository,
    pullRequestIdentity: inputs.pullRequest.providerId,
    finding: inputs.finding,
  });
}

/**
 * The one provider-visible mark that says which obligation an issue records.
 *
 * The natural key's own digest, written into the body where a Git host can be
 * searched for it. Because it is the key rather than a name beside it, an issue
 * carrying this marker is an issue about this Repository, this pull request and
 * this finding — there is no arrangement of the three that produces another
 * one's mark.
 */
export function issueOriginMarker(key: IssueNaturalKey): string {
  return `<!-- executablemd-issue: ${canonicalFingerprint(issueNaturalKeyJson(key))} -->`;
}

/**
 * The issue body this request asks the Git host to hold, exactly.
 *
 * Composed here rather than in an adapter, because it is what an adoption is
 * judged against: two readings of "what this issue should say" would be two
 * things to keep in agreement, and a disagreement between them would update an
 * issue on every attempt forever.
 *
 * The evidence goes in verbatim. What is added around it is where the deferral
 * came from — the run and the expansion that decided it, and the pull request
 * it was decided against — so somebody reading the issue can find the decision
 * without having the document in front of them.
 */
export function issueBody(inputs: IssueInputs, identity: GitHostEffectIdentity): string {
  return [
    issueOriginMarker(issueNaturalKey(inputs)),
    "",
    inputs.body,
    "",
    "## Why it was deferred",
    "",
    inputs.rationale,
    "",
    "## What it depends on",
    "",
    inputs.dependencyImpact,
    "",
    "## When it is intended",
    "",
    inputs.intendedTiming,
    "",
    "## Where this came from",
    "",
    `- Pull request: ${inputs.pullRequest.url} (#${inputs.pullRequest.number})`,
    `- Finding: ${inputs.finding}`,
    `- Workflow run: ${identity.runId}`,
    `- Expansion: ${identity.expansionId}`,
    "",
  ].join("\n");
}

/** The public result one settled issue produces for these inputs. */
export function issueResultOf(inputs: IssueInputs, snapshot: IssueSnapshot): IssueResult {
  return Object.freeze({
    repository: inputs.repository,
    pullRequest: Object.freeze({
      number: inputs.pullRequest.number,
      url: inputs.pullRequest.url,
    }),
    providerId: snapshot.providerId,
    number: snapshot.number,
    url: snapshot.url,
    state: OPEN,
    finding: inputs.finding,
  });
}

/** Whether this issue is the one these inputs ask for. */
export function issueAgrees(
  snapshot: IssueSnapshot,
  inputs: IssueInputs,
  identity: GitHostEffectIdentity,
): boolean {
  return (
    snapshot.state === OPEN &&
    snapshot.title === inputs.title &&
    snapshot.body === issueBody(inputs, identity)
  );
}

/**
 * Whether an issue about to be updated is the one that was updated.
 *
 * A performed update describes one issue before and after itself, and a record
 * whose two halves name different issues describes something this operation
 * cannot do. The number and the provider's identity are the two facts an update
 * may never move.
 */
export function sameIssueIdentity(before: IssueSnapshot, after: IssueSnapshot): boolean {
  return before.providerId === after.providerId && before.number === after.number;
}

/** The issue inputs this value describes, or `undefined`. */
export function parseIssueInputs(value: unknown): IssueInputs | undefined {
  const record = members(value, INPUT_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  const repository = parseGitPushRepositoryIdentity(record.repository);
  const pullRequest = parsePullRequestEvidence(record.pullRequest);
  const finding = text(record.finding);
  const title = text(record.title);
  const body = bodyText(record.body);
  const rationale = text(record.rationale);
  const dependencyImpact = text(record.dependencyImpact);
  const intendedTiming = text(record.intendedTiming);
  if (
    repository === undefined ||
    pullRequest === undefined ||
    finding === undefined ||
    record.disposition !== DEFER ||
    title === undefined ||
    body === undefined ||
    rationale === undefined ||
    dependencyImpact === undefined ||
    intendedTiming === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    repository,
    pullRequest,
    finding,
    disposition: DEFER,
    title,
    body,
    rationale,
    dependencyImpact,
    intendedTiming,
  });
}

/** The issue natural key this value describes, or `undefined`. */
export function parseIssueNaturalKey(value: unknown): IssueNaturalKey | undefined {
  const record = members(value, KEY_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  const repository = parseGitPushRepositoryIdentity(record.repository);
  const pullRequestIdentity = text(record.pullRequestIdentity);
  const finding = text(record.finding);
  if (repository === undefined || pullRequestIdentity === undefined || finding === undefined) {
    return undefined;
  }
  return Object.freeze({ repository, pullRequestIdentity, finding });
}

/**
 * Whether two readings of an issue request ask for the same thing.
 *
 * Every member, because this is what a live provider holds an arriving request
 * to before it answers for it. A request agreeing in the natural key alone
 * would let a completion be published for text this invocation never described.
 */
export function sameIssueInputs(left: IssueInputs, right: IssueInputs): boolean {
  return (
    sameRepositoryIdentity(left.repository, right.repository) &&
    samePullRequestEvidence(left.pullRequest, right.pullRequest) &&
    left.finding === right.finding &&
    left.disposition === right.disposition &&
    left.title === right.title &&
    left.body === right.body &&
    left.rationale === right.rationale &&
    left.dependencyImpact === right.dependencyImpact &&
    left.intendedTiming === right.intendedTiming
  );
}

/** Whether two natural keys name the same obligation. */
export function sameIssueNaturalKey(left: IssueNaturalKey, right: IssueNaturalKey): boolean {
  return (
    sameRepositoryIdentity(left.repository, right.repository) &&
    left.pullRequestIdentity === right.pullRequestIdentity &&
    left.finding === right.finding
  );
}

/** The issue snapshot this value describes, or `undefined`. */
export function parseIssueSnapshot(value: unknown): IssueSnapshot | undefined {
  const record = members(value, SNAPSHOT_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  const providerId = text(record.providerId);
  const number = issueNumber(record.number);
  const url = text(record.url);
  const title = text(record.title);
  const body = bodyText(record.body);
  if (
    providerId === undefined ||
    number === undefined ||
    url === undefined ||
    record.state !== OPEN ||
    title === undefined ||
    body === undefined
  ) {
    return undefined;
  }
  return Object.freeze({ providerId, number, url, state: OPEN, title, body });
}

/** The pre-state this value describes, or `undefined` when it describes none. */
export function parseIssuePreState(value: unknown): IssuePreState | undefined {
  const record = members(value, PRE_STATE_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  if (record.issue === null) {
    return Object.freeze({ issue: null });
  }
  const issue = parseIssueSnapshot(record.issue);
  return issue === undefined ? undefined : Object.freeze({ issue });
}

/** The observations this value describes, or `undefined`. */
export function parseIssueObservations(value: unknown): IssueObservations | undefined {
  const record = members(value, OBSERVATION_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  const issue = parseIssueSnapshot(record.issue);
  return issue === undefined ? undefined : Object.freeze({ issue });
}

/**
 * The issue result this value describes for this request, or `undefined`.
 *
 * Exact about membership and closed about meaning. Beyond the shape it refuses
 * a result naming another Repository, another pull request, another finding or
 * a state other than open. What it cannot decide alone is the provider's
 * identity, the number and the URL: those come from the Git host, and holding
 * them to the observations is {@link parseIssueRecord}'s job.
 */
export function parseIssueResult(
  value: unknown,
  expected: IssueExpectation,
): IssueResult | undefined {
  const record = members(value, RESULT_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  const reference = members(record.pullRequest, REFERENCE_MEMBERS);
  if (reference === undefined) {
    return undefined;
  }
  const repository = parseGitPushRepositoryIdentity(record.repository);
  const number = issueNumber(record.number);
  const url = text(record.url);
  const providerId = text(record.providerId);
  const finding = text(record.finding);
  const pullRequestNumberValue = pullRequestNumber(reference.number);
  const pullRequestUrl = text(reference.url);
  if (
    repository === undefined ||
    providerId === undefined ||
    number === undefined ||
    url === undefined ||
    finding === undefined ||
    pullRequestNumberValue === undefined ||
    pullRequestUrl === undefined ||
    record.state !== OPEN
  ) {
    return undefined;
  }
  if (
    !sameRepositoryIdentity(repository, expected.repository) ||
    finding !== expected.finding ||
    pullRequestNumberValue !== expected.pullRequest.number ||
    pullRequestUrl !== expected.pullRequest.url
  ) {
    return undefined;
  }
  return Object.freeze({
    repository,
    pullRequest: Object.freeze({ number: pullRequestNumberValue, url: pullRequestUrl }),
    providerId,
    number,
    url,
    state: OPEN,
    finding,
  });
}

/**
 * The issue this reconciliation record describes, or `undefined`.
 *
 * The shared engine has already held the record's request to the request being
 * made and parsed the record's own shape. What is decided here is everything
 * effect-specific: that the record's natural key names the obligation these
 * inputs name, that each of the three JSON members is an issue shape, that the
 * observed issue is the one this request asks for, that the public result names
 * that exact issue, and that the decision is one the pre-state supports.
 *
 * The decision and the pre-state are one fact:
 *
 * ```text
 * performed   nothing was there, and this attempt created it
 * performed   it was there differing, and this attempt changed it
 * adopted     it was there already as asked, and nothing was changed
 * ```
 *
 * A performed update whose pre-state already held the requested title and body
 * describes work that had nothing to do, and is refused: the only decision that
 * reaches is `adopted`.
 */
export function parseIssueRecord(
  record: GitHostReconciliationRecord,
  expected: IssueExpectation,
): IssueOutcome | undefined {
  const key = parseIssueNaturalKey(record.request.naturalKey);
  if (key === undefined || !sameIssueNaturalKey(key, issueNaturalKey(expected))) {
    return undefined;
  }
  const preState = parseIssuePreState(record.preState);
  const observations = parseIssueObservations(record.observations);
  const result = parseIssueResult(record.result, expected);
  if (preState === undefined || observations === undefined || result === undefined) {
    return undefined;
  }
  const observed = observations.issue;
  // Whatever happened, what it finished at is what was asked for.
  if (!issueAgrees(observed, expected, record.request.identity)) {
    return undefined;
  }
  if (
    result.providerId !== observed.providerId ||
    result.number !== observed.number ||
    result.url !== observed.url
  ) {
    return undefined;
  }
  return supported(record.decision, preState.issue, observed)
    ? Object.freeze({ decision: record.decision, result })
    : undefined;
}

/** Whether this decision is one that pre-state supports. */
function supported(
  decision: GitHostDecision,
  before: IssueSnapshot | null,
  observed: IssueSnapshot,
): boolean {
  if (decision === "adopted") {
    // Nothing was performed, so what was there is what is there: the pre-state
    // and the final observation are one reading of one issue.
    return (
      before !== null && SNAPSHOT_MEMBERS.every((member) => before[member] === observed[member])
    );
  }
  if (before === null) {
    return true;
  }
  return (
    sameIssueIdentity(before, observed) &&
    !(before.title === observed.title && before.body === observed.body)
  );
}
