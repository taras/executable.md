/**
 * What one `<PullRequest>` asks for, and what its reconciliation retains.
 *
 * A pull request is a collaboration object a Git host owns, so the effect is
 * reconciled through the shared Git-host state machine rather than committed
 * with a Workspace transaction — and what travels through that boundary is JSON
 * a provider in another package receives and a journal in this one keeps. None
 * of it is this module's word by the time it is read back, so every value is
 * parsed exactly.
 *
 * ## The Repository travels the way a Push's does
 *
 * The same filtered identity, from the same function. A Git host has no
 * business holding the run's own checkout path, and a second name for the six
 * members that remain would be a second thing to keep in agreement with the
 * first. Two effect kinds now name a Repository the same way, which is the
 * condition for sharing one — not a reason to move it somewhere neither of them
 * lives.
 *
 * ## One element, two resources, two natural keys
 *
 * `<PullRequest>` is an upsert over one explicit pull-request identity, and
 * which identity that is, is what `number` decides. Without a number the
 * document is asking for *a pull request from this head to this base*, and the
 * resource is that branch pair. With a number it is asking for *that pull
 * request*, and the resource is the number. Those are different external
 * resources, so they are different natural keys — not one key with a member
 * that is sometimes absent, which would make a numbered update and an unnumbered
 * creation look each other up.
 *
 * ```text
 * { mode: "create", repository, headBranch, baseBranch }
 * { mode: "update", repository, number }
 * ```
 *
 * The complete request fingerprint still covers every input, so a changed
 * title, body, draft flag, base, head commit or number diverges at the durable
 * position rather than consuming the result retained for another question.
 *
 * ## The result is what the reconciliation settled on
 *
 * What a document binds is the pull request this effect left behind: the
 * provider's stable identity for it, its number, its URL, and the head and base
 * commits of the snapshot the reconciliation finished at. Reviews, checks,
 * labels and later edits are separate reads. A retained record that re-read
 * them would be answering a different question every time it replayed.
 */

import type { Json } from "@executablemd/durable-streams";
import type { GitHostDecision, GitHostReconciliationRecord } from "../git-host/records.ts";
import { members, text } from "./parse.ts";
import {
  gitObjectId,
  gitPushRepositoryIdentityJson,
  parseGitPushRepositoryIdentity,
  sameRepositoryIdentity,
  type GitPushRepositoryIdentity,
} from "./git-push-records.ts";
import type { GitObjectFormat, RepositoryRecord } from "./records.ts";

/** The Git-host effect kind one pull-request upsert is reconciled under. */
export const PULL_REQUEST = "pull-request";

/** The one state a pull request this effect settles on is in. */
export const OPEN = "open";

/** Which resource this invocation names: a branch pair, or a number. */
export type PullRequestMode = "create" | "update";

/** What a `<PullRequest>` invocation asks the provider to do. */
export interface PullRequestRequest {
  /** The whole Repository record the component observed, to be compared. */
  readonly repository: RepositoryRecord;
  /** The logical working directory the component observed. */
  readonly workingDirectory: string;
  /** The pull request to update, or `null` to ask for one to exist. */
  readonly number: number | null;
  readonly title: string;
  /** The rendered invocation content, verbatim. Empty content is `""`. */
  readonly body: string;
  readonly draft: boolean;
  /** The base branch, already defaulted to the Repository's primary branch. */
  readonly base: string;
}

/** The filtered inputs one pull-request reconciliation acts on. */
export interface PullRequestInputs {
  readonly repository: GitPushRepositoryIdentity;
  /**
   * The pull request this asks for by number, or `null` when it asks for one to
   * exist.
   *
   * Normalized here and nowhere else: absence is `null` in durable JSON,
   * because `undefined` is not a JSON value and a member that is sometimes
   * missing is a second shape rather than a value.
   */
  readonly number: number | null;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
  readonly headBranch: string;
  readonly headSha: string;
  readonly baseBranch: string;
}

/** What the provider looks an unnumbered request up by: the branch pair. */
export interface PullRequestCreateKey {
  readonly mode: "create";
  readonly repository: GitPushRepositoryIdentity;
  readonly headBranch: string;
  readonly baseBranch: string;
}

/** What the provider looks a numbered request up by: that exact number. */
export interface PullRequestUpdateKey {
  readonly mode: "update";
  readonly repository: GitPushRepositoryIdentity;
  readonly number: number;
}

export type PullRequestNaturalKey = PullRequestCreateKey | PullRequestUpdateKey;

/** One open pull request, normalized away from whatever a provider calls it. */
export interface PullRequestSnapshot {
  /** The provider's own stable identity for this pull request. */
  readonly providerId: string;
  readonly number: number;
  readonly url: string;
  readonly state: "open";
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
  readonly headBranch: string;
  readonly headSha: string;
  readonly baseBranch: string;
  readonly baseSha: string;
}

/**
 * What the Git host held for this resource before this attempt.
 *
 * `null` only where nothing was there: an unnumbered request that proved no
 * pull request exists for its branch pair. A numbered request that is about to
 * be updated has a pre-state — the pull request as it was before the update —
 * and that is what makes a performed update describable at all.
 */
export interface PullRequestPreState {
  readonly pullRequest: PullRequestSnapshot | null;
}

/** The pull request this effect finished at, observed after everything it did. */
export interface PullRequestObservations {
  readonly pullRequest: PullRequestSnapshot;
}

/** What a reconciled pull request retains, and what a document binds. */
export interface PullRequestResult {
  readonly repository: GitPushRepositoryIdentity;
  readonly providerId: string;
  readonly number: number;
  readonly url: string;
  readonly state: "open";
  readonly headSha: string;
  readonly baseSha: string;
}

/** One reconciled pull request: what the shared engine decided, and what it retains. */
export interface PullRequestOutcome {
  readonly decision: GitHostDecision;
  readonly result: PullRequestResult;
}

/**
 * What a retained pull-request record is read back for.
 *
 * The complete admitted inputs, because every one of them is something the
 * record has to agree with: the resource it names, the immutable facts it was
 * settled against, and the mutable fields the final snapshot has to hold.
 */
export type PullRequestExpectation = PullRequestInputs;

const INPUT_MEMBERS = [
  "repository",
  "number",
  "title",
  "body",
  "draft",
  "headBranch",
  "headSha",
  "baseBranch",
] as const;

const CREATE_KEY_MEMBERS = ["mode", "repository", "headBranch", "baseBranch"] as const;

const UPDATE_KEY_MEMBERS = ["mode", "repository", "number"] as const;

const SNAPSHOT_MEMBERS = [
  "providerId",
  "number",
  "url",
  "state",
  "title",
  "body",
  "draft",
  "headBranch",
  "headSha",
  "baseBranch",
  "baseSha",
] as const;

const PRE_STATE_MEMBERS = ["pullRequest"] as const;

const OBSERVATION_MEMBERS = ["pullRequest"] as const;

const RESULT_MEMBERS = [
  "repository",
  "providerId",
  "number",
  "url",
  "state",
  "headSha",
  "baseSha",
] as const;

/**
 * A pull-request number, as a number rather than as something numeric.
 *
 * A positive integer and nothing else. A float, a negative, an exponent and a
 * numeric string are all values a provider or a document could put here, and
 * reading one as a number would name a pull request nothing has.
 */
export function pullRequestNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** The number this value asks for, `null` for none, or `undefined` for neither. */
function optionalNumber(value: unknown): number | null | undefined {
  return value === null ? null : pullRequestNumber(value);
}

/** The body of a pull request, which may be empty and may not be absent. */
function bodyText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function flag(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Which resource these inputs name. */
export function pullRequestMode(inputs: PullRequestInputs): PullRequestMode {
  return inputs.number === null ? "create" : "update";
}

export function pullRequestInputsJson(inputs: PullRequestInputs): Json {
  return {
    repository: gitPushRepositoryIdentityJson(inputs.repository),
    number: inputs.number,
    title: inputs.title,
    body: inputs.body,
    draft: inputs.draft,
    headBranch: inputs.headBranch,
    headSha: inputs.headSha,
    baseBranch: inputs.baseBranch,
  };
}

export function pullRequestNaturalKeyJson(key: PullRequestNaturalKey): Json {
  return key.mode === "create"
    ? {
        mode: key.mode,
        repository: gitPushRepositoryIdentityJson(key.repository),
        headBranch: key.headBranch,
        baseBranch: key.baseBranch,
      }
    : {
        mode: key.mode,
        repository: gitPushRepositoryIdentityJson(key.repository),
        number: key.number,
      };
}

export function pullRequestSnapshotJson(snapshot: PullRequestSnapshot): Json {
  return {
    providerId: snapshot.providerId,
    number: snapshot.number,
    url: snapshot.url,
    state: snapshot.state,
    title: snapshot.title,
    body: snapshot.body,
    draft: snapshot.draft,
    headBranch: snapshot.headBranch,
    headSha: snapshot.headSha,
    baseBranch: snapshot.baseBranch,
    baseSha: snapshot.baseSha,
  };
}

export function pullRequestPreStateJson(preState: PullRequestPreState): Json {
  return {
    pullRequest:
      preState.pullRequest === null ? null : pullRequestSnapshotJson(preState.pullRequest),
  };
}

export function pullRequestObservationsJson(observations: PullRequestObservations): Json {
  return { pullRequest: pullRequestSnapshotJson(observations.pullRequest) };
}

export function pullRequestResultJson(result: PullRequestResult): Json {
  return {
    repository: gitPushRepositoryIdentityJson(result.repository),
    providerId: result.providerId,
    number: result.number,
    url: result.url,
    state: result.state,
    headSha: result.headSha,
    baseSha: result.baseSha,
  };
}

/** The natural key these admitted inputs describe. */
export function pullRequestNaturalKey(inputs: PullRequestInputs): PullRequestNaturalKey {
  return inputs.number === null
    ? Object.freeze({
        mode: "create" as const,
        repository: inputs.repository,
        headBranch: inputs.headBranch,
        baseBranch: inputs.baseBranch,
      })
    : Object.freeze({
        mode: "update" as const,
        repository: inputs.repository,
        number: inputs.number,
      });
}

/** The public result one settled pull request produces for these inputs. */
export function pullRequestResultOf(
  inputs: PullRequestInputs,
  snapshot: PullRequestSnapshot,
): PullRequestResult {
  return Object.freeze({
    repository: inputs.repository,
    providerId: snapshot.providerId,
    number: snapshot.number,
    url: snapshot.url,
    state: OPEN,
    headSha: snapshot.headSha,
    baseSha: snapshot.baseSha,
  });
}

/**
 * Whether this pull request is the one these inputs ask for.
 *
 * Every field the request names — the mutable four this element can move, the
 * two head facts it may never move, and the number when one was supplied. What
 * is deliberately not here is the base commit: a document asks for a base
 * *branch*, the commit that branch holds is what the reconciliation observes,
 * and requiring the request to have predicted it would make every adoption
 * impossible.
 */
export function pullRequestAgrees(
  snapshot: PullRequestSnapshot,
  inputs: PullRequestInputs,
): boolean {
  return (
    snapshot.state === OPEN &&
    snapshot.title === inputs.title &&
    snapshot.body === inputs.body &&
    snapshot.draft === inputs.draft &&
    snapshot.headBranch === inputs.headBranch &&
    snapshot.headSha === inputs.headSha &&
    snapshot.baseBranch === inputs.baseBranch &&
    (inputs.number === null || snapshot.number === inputs.number)
  );
}

/**
 * Whether a pull request about to be updated is the one that was updated.
 *
 * The facts an update may not move. A performed update describes one pull
 * request before and after itself, and a record whose two halves name different
 * pull requests — or the same number under another identity, or a head this
 * element never touches — describes something this operation cannot do.
 */
export function samePullRequestIdentity(
  before: PullRequestSnapshot,
  after: PullRequestSnapshot,
): boolean {
  return (
    before.providerId === after.providerId &&
    before.number === after.number &&
    before.headBranch === after.headBranch &&
    before.headSha === after.headSha
  );
}

/** The pull-request inputs this value describes, or `undefined`. */
export function parsePullRequestInputs(value: unknown): PullRequestInputs | undefined {
  const record = members(value, INPUT_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  const repository = parseGitPushRepositoryIdentity(record.repository);
  const number = optionalNumber(record.number);
  const title = text(record.title);
  const body = bodyText(record.body);
  const draft = flag(record.draft);
  const headBranch = text(record.headBranch);
  const baseBranch = text(record.baseBranch);
  if (
    repository === undefined ||
    number === undefined ||
    title === undefined ||
    body === undefined ||
    draft === undefined ||
    headBranch === undefined ||
    baseBranch === undefined
  ) {
    return undefined;
  }
  const headSha = gitObjectId(record.headSha, repository.objectFormat);
  if (headSha === undefined) {
    return undefined;
  }
  return Object.freeze({
    repository,
    number,
    title,
    body,
    draft,
    headBranch,
    headSha,
    baseBranch,
  });
}

/**
 * The pull-request natural key this value describes, or `undefined`.
 *
 * The mode selects which members the value must carry exactly, so a create key
 * with a number and an update key with a branch pair are both refused rather
 * than read as the other one with something extra.
 */
export function parsePullRequestNaturalKey(value: unknown): PullRequestNaturalKey | undefined {
  const mode = readMode(value);
  if (mode === "create") {
    const record = members(value, CREATE_KEY_MEMBERS);
    if (record === undefined) {
      return undefined;
    }
    const repository = parseGitPushRepositoryIdentity(record.repository);
    const headBranch = text(record.headBranch);
    const baseBranch = text(record.baseBranch);
    if (repository === undefined || headBranch === undefined || baseBranch === undefined) {
      return undefined;
    }
    return Object.freeze({ mode, repository, headBranch, baseBranch });
  }
  if (mode !== "update") {
    return undefined;
  }
  const record = members(value, UPDATE_KEY_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  const repository = parseGitPushRepositoryIdentity(record.repository);
  const number = pullRequestNumber(record.number);
  if (repository === undefined || number === undefined) {
    return undefined;
  }
  return Object.freeze({ mode, repository, number });
}

/** The word this value uses for its mode, read on its own. */
function readMode(value: unknown): unknown {
  try {
    return typeof value === "object" && value !== null ? Reflect.get(value, "mode") : undefined;
  } catch {
    return undefined;
  }
}

/** Whether two natural keys name the same resource. */
export function sameNaturalKey(left: PullRequestNaturalKey, right: PullRequestNaturalKey): boolean {
  if (left.mode !== right.mode) {
    return false;
  }
  if (!sameRepositoryIdentity(left.repository, right.repository)) {
    return false;
  }
  return left.mode === "create" && right.mode === "create"
    ? left.headBranch === right.headBranch && left.baseBranch === right.baseBranch
    : left.mode === "update" && right.mode === "update" && left.number === right.number;
}

/** The pull-request snapshot this value describes, or `undefined`. */
export function parsePullRequestSnapshot(
  value: unknown,
  format: GitObjectFormat,
): PullRequestSnapshot | undefined {
  const record = members(value, SNAPSHOT_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  const providerId = text(record.providerId);
  const number = pullRequestNumber(record.number);
  const url = text(record.url);
  const title = text(record.title);
  const body = bodyText(record.body);
  const draft = flag(record.draft);
  const headBranch = text(record.headBranch);
  const headSha = gitObjectId(record.headSha, format);
  const baseBranch = text(record.baseBranch);
  const baseSha = gitObjectId(record.baseSha, format);
  if (
    providerId === undefined ||
    number === undefined ||
    url === undefined ||
    record.state !== OPEN ||
    title === undefined ||
    body === undefined ||
    draft === undefined ||
    headBranch === undefined ||
    headSha === undefined ||
    baseBranch === undefined ||
    baseSha === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    providerId,
    number,
    url,
    state: OPEN,
    title,
    body,
    draft,
    headBranch,
    headSha,
    baseBranch,
    baseSha,
  });
}

/** The pre-state this value describes, or `undefined` when it describes none. */
export function parsePullRequestPreState(
  value: unknown,
  format: GitObjectFormat,
): PullRequestPreState | undefined {
  const record = members(value, PRE_STATE_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  if (record.pullRequest === null) {
    return Object.freeze({ pullRequest: null });
  }
  const pullRequest = parsePullRequestSnapshot(record.pullRequest, format);
  return pullRequest === undefined ? undefined : Object.freeze({ pullRequest });
}

/** The observations this value describes, or `undefined`. */
export function parsePullRequestObservations(
  value: unknown,
  format: GitObjectFormat,
): PullRequestObservations | undefined {
  const record = members(value, OBSERVATION_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  const pullRequest = parsePullRequestSnapshot(record.pullRequest, format);
  return pullRequest === undefined ? undefined : Object.freeze({ pullRequest });
}

/**
 * The pull-request result this value describes for this request, or `undefined`.
 *
 * Exact about membership and closed about meaning. Beyond the shape it refuses
 * a result naming another Repository, a state other than open, a head commit
 * that is not the one this invocation reconciled against, and — when a number
 * was supplied — another number. What it cannot decide alone is the URL and the
 * base commit: those come from the Git host, and holding them to the
 * observations is {@link parsePullRequestRecord}'s job.
 */
export function parsePullRequestResult(
  value: unknown,
  expected: PullRequestExpectation,
): PullRequestResult | undefined {
  const record = members(value, RESULT_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  const format = expected.repository.objectFormat;
  const repository = parseGitPushRepositoryIdentity(record.repository);
  const providerId = text(record.providerId);
  const number = pullRequestNumber(record.number);
  const url = text(record.url);
  const headSha = gitObjectId(record.headSha, format);
  const baseSha = gitObjectId(record.baseSha, format);
  if (
    repository === undefined ||
    providerId === undefined ||
    number === undefined ||
    url === undefined ||
    headSha === undefined ||
    baseSha === undefined ||
    record.state !== OPEN
  ) {
    return undefined;
  }
  if (
    !sameRepositoryIdentity(repository, expected.repository) ||
    headSha !== expected.headSha ||
    (expected.number !== null && number !== expected.number)
  ) {
    return undefined;
  }
  return Object.freeze({
    repository,
    providerId,
    number,
    url,
    state: OPEN,
    headSha,
    baseSha,
  });
}

/**
 * The pull request this reconciliation record describes, or `undefined`.
 *
 * The shared engine has already held the record's request to the request being
 * made and parsed the record's own shape. What is decided here is everything
 * effect-specific: that the record's natural key names the resource these
 * inputs name, that each of the three JSON members is a pull-request shape,
 * that the observed pull request is the one this request asks for, that the
 * public result names that exact pull request, and that the decision is one the
 * pre-state supports in this mode.
 *
 * The decision, the mode and the pre-state are one fact:
 *
 * ```text
 * create  performed   nothing was there, and this attempt created it
 * create  adopted     it was already there, exactly as asked
 * update  performed   it was there differing, and this attempt changed it
 * update  adopted     it was there already as asked, and nothing was changed
 * ```
 *
 * The middle two are told apart by the pre-state, not by the word: a performed
 * update whose pre-state already held every requested field describes work that
 * had nothing to do, and is refused.
 *
 * A record pairing any other combination describes a reconciliation the state
 * machine cannot reach — a created pull request with something before it, an
 * update performed over nothing, or an adoption whose pre-state is not what it
 * says it observed.
 */
export function parsePullRequestRecord(
  record: GitHostReconciliationRecord,
  expected: PullRequestExpectation,
): PullRequestOutcome | undefined {
  const format = expected.repository.objectFormat;
  const key = parsePullRequestNaturalKey(record.request.naturalKey);
  if (key === undefined || !sameNaturalKey(key, pullRequestNaturalKey(expected))) {
    return undefined;
  }
  const preState = parsePullRequestPreState(record.preState, format);
  const observations = parsePullRequestObservations(record.observations, format);
  const result = parsePullRequestResult(record.result, expected);
  if (preState === undefined || observations === undefined || result === undefined) {
    return undefined;
  }
  const observed = observations.pullRequest;
  // Whatever happened, what it finished at is what was asked for.
  if (!pullRequestAgrees(observed, expected)) {
    return undefined;
  }
  if (
    result.providerId !== observed.providerId ||
    result.number !== observed.number ||
    result.url !== observed.url ||
    result.headSha !== observed.headSha ||
    result.baseSha !== observed.baseSha
  ) {
    return undefined;
  }
  return supported(record.decision, key.mode, preState.pullRequest, observed)
    ? Object.freeze({ decision: record.decision, result })
    : undefined;
}

/** Whether this decision, in this mode, is one that pre-state supports. */
function supported(
  decision: GitHostDecision,
  mode: PullRequestMode,
  before: PullRequestSnapshot | null,
  observed: PullRequestSnapshot,
): boolean {
  if (decision === "adopted") {
    // Nothing was performed, so what was there is what is there: the pre-state
    // and the final observation are one reading of one pull request.
    return before !== null && samePullRequest(before, observed);
  }
  if (mode === "create") {
    return before === null;
  }
  // A performed update acted on a pull request that was already there and left
  // the same one behind, so the immutable identity is compared. What is also
  // required is a reason for it to have been performed at all: a pre-state that
  // already agreed with every requested mutable field describes an update with
  // nothing to do, and the only decision that reaches is `adopted`.
  return (
    before !== null &&
    samePullRequestIdentity(before, observed) &&
    !mutableFieldsAgree(before, observed)
  );
}

/**
 * Whether these two readings of one pull request differ in nothing this element
 * moves.
 *
 * The four fields an update may change. Comparing the pre-state with the final
 * observation rather than with the request is what makes this a statement about
 * the update: the observation is already held to the request above, so two
 * readings that agree here are two readings of a pull request nothing changed.
 */
function mutableFieldsAgree(before: PullRequestSnapshot, after: PullRequestSnapshot): boolean {
  return (
    before.title === after.title &&
    before.body === after.body &&
    before.draft === after.draft &&
    before.baseBranch === after.baseBranch
  );
}

/**
 * Whether two snapshots describe the same pull request in the same state.
 *
 * What an adoption claims is that the pull request that was already there is
 * the one this record retains — every member, not merely the ones the request
 * named. A pre-state naming another number, another URL or another base commit
 * describes a pull request the observations are not about.
 */
function samePullRequest(left: PullRequestSnapshot, right: PullRequestSnapshot): boolean {
  return SNAPSHOT_MEMBERS.every((member) => left[member] === right[member]);
}
