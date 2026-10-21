/**
 * Whether one entry's retained external history may be continued at all.
 *
 * An entry retains two external protocols: the branch it published, and the
 * pull request it asked for over that branch. One walk admits both, because the
 * two interleave in one stream and a second reader would be a second pairing
 * algorithm that could disagree with this one.
 *
 * Three questions, and only three. **Integrity**: every saved request parses,
 * states this version, and is published under the name its own question
 * produces. **Ownership**: every request and every outcome names this entry's
 * owner, because the owner is what the durable name is derived from — a record
 * written under another one would replay under a name this entry never
 * presented. **Pairing**: an outcome stands at the position after the request it
 * answers, carries that request's own fingerprint, and reads back as the result
 * that kind of work produces.
 *
 * Nothing else. No checkout is inspected, no origin is contacted, no object is
 * read, no path is resolved and no result is handed out: replaying a completed
 * operation is the durable engine's own positional matching, and this runs
 * before any of it. Whether the branch a record names is still where it was is
 * not this reader's question, and not a question a continuation asks.
 *
 * ## A trailing request is history, not damage
 *
 * An entry interrupted between publishing its request and obtaining the host's
 * answer leaves exactly one unanswered request. That is the state this whole
 * feature exists for, so it is admitted: the continuation reconciles that saved
 * request rather than resolving a new one. What is refused is an outcome with no
 * request before it, a request answered twice, and a receipt this build cannot
 * read — each of which would let a continuation believe something was published
 * that this history cannot account for.
 *
 * ## Coroutines are independent
 *
 * Pairing is per coroutine, because a position belongs to one. Two `<All>`
 * branches each publishing a branch interleave in the stream and neither one's
 * outcome answers the other's request. Nothing is matched by searching the
 * stream for a name: equal requests at two positions are two occurrences, and a
 * reader that deduplicated them would refuse a document that is allowed.
 */

import { StaleInputError } from "@executablemd/durable-streams";
import type { DurableEvent, Json, Result, Yield } from "@executablemd/durable-streams";
import type { Operation } from "effection";
import { canonicalJson } from "@executablemd/workflow";
import {
  GIT_PUSH,
  gitPushInputsJson,
  gitPushNaturalKeyJson,
  parseGitPushRecord,
  pushExpectation,
  type GitPushInputs,
} from "@executablemd/git";
import { sameRepositoryIdentity } from "@executablemd/git";
import { type RepositoryIdentity } from "@executablemd/git";
import { GIT_HOST_EFFECT } from "@executablemd/git";
import { gitHostRequestFingerprint, parseGitHostReconciliationRecord } from "@executablemd/git";
import type { GitHostReconciliationRecord } from "@executablemd/git";
import { parseReplPlacementRecord, REPL_REPOSITORY_PLACEMENT } from "./placement-records.ts";
import {
  parseReplPushRequestRecord,
  replPushRequestName,
  REPL_REPOSITORY_PUSH_REQUEST,
  type ReplPushRequestRecord,
} from "./push-records.ts";
import {
  parseReplPullRequestRequestRecord,
  replPullRequestRequestName,
  REPL_REPOSITORY_PULL_REQUEST_REQUEST,
  type ReplPullRequestRequestRecord,
} from "./pull-request-records.ts";
import {
  PULL_REQUEST,
  parsePullRequestRecord,
  pullRequestInputsJson,
  pullRequestNaturalKey,
  pullRequestNaturalKeyJson,
  type PullRequestInputs,
} from "@executablemd/git";
import { REPL_REPOSITORY_VERSION, statedReplRecordVersion } from "./records.ts";

/** Why a publication history cannot be continued. */
export type ReplPushRefusal =
  /** A Push record of this feature's type that this version cannot read. */
  | "malformed-record"
  /** A record stating a version this host does not implement. */
  | "unknown-version"
  /** A record whose name is not the name of the request it carries. */
  | "request-fingerprint"
  /** A record naming a history that is not this entry's. */
  | "foreign-owner"
  /** A saved request naming a checkout this entry holds no placement for. */
  | "unknown-placement"
  /** A Git-host outcome standing where no request asked for one. */
  | "orphan-outcome"
  /** A second outcome for a request one already answered. */
  | "duplicate-outcome"
  /** A settled outcome that is not the result a Push produces. */
  | "malformed-receipt";

/**
 * A retained publication history this entry cannot continue from.
 *
 * Fatal by construction: it extends `StaleInputError`, so it ends the attempt
 * rather than becoming a value a document can print away and carry on past.
 */
export class ReplPushHistoryError extends StaleInputError {
  override name = "ReplPushHistoryError";

  readonly reason: ReplPushRefusal;

  constructor(reason: ReplPushRefusal, sentence: string) {
    super(sentence);
    this.reason = reason;
  }
}

/**
 * One place this entry holds, as parsed facts alone.
 *
 * What a saved request is checked against, on both paths and with the same
 * arithmetic: during admission these come from the placement records the
 * snapshot holds, and at an invocation they come from the private registry this
 * execution rebuilt. Neither reading resolves a path or opens anything.
 */
export interface ReplPushPlacement {
  readonly identity: RepositoryIdentity;
  readonly checkoutRoot: string;
  readonly commonDirectory: string;
}

/**
 * One place a saved request names: a Repository, and the checkout it sits in.
 *
 * Three of these are read off every saved request, and each record kind reads
 * them out of its own shape. What is done with them is {@link placesHeld}.
 */
type ReplRequestPlace = readonly [RepositoryIdentity, string, string];

/**
 * Whether every place a request named is one these placements hold.
 *
 * One placement rule, over whichever readings a record supplied: a place is
 * held when some placement sits at that exact checkout root and common
 * directory *and* is a placement of the Repository the record names. Neither
 * reading resolves a path nor opens anything.
 */
function placesHeld(
  places: readonly ReplRequestPlace[],
  placements: readonly ReplPushPlacement[],
): boolean {
  return places.every(([identity, checkoutRoot, commonDirectory]) =>
    placements.some(
      (placement) =>
        placement.checkoutRoot === checkoutRoot &&
        placement.commonDirectory === commonDirectory &&
        sameRepositoryIdentity(placement.identity, identity),
    ),
  );
}

/**
 * Whether every place a saved request names is one these placements hold.
 *
 * Three readings and three questions. The selection the invocation
 * authenticated, the selection the live dispatch received, and the checkout
 * routing resolved all have to be placements of the Repository the record
 * names — a request whose saved root belongs to nothing this entry holds does
 * not say where the publication was asked for.
 */
export function replPushPlacesHeld(
  record: ReplPushRequestRecord,
  placements: readonly ReplPushPlacement[],
): boolean {
  const places: readonly ReplRequestPlace[] = [
    [
      record.requested.repository,
      record.requested.selectionCheckout,
      record.requested.commonDirectory,
    ],
    [
      record.received.repository,
      record.received.selectionCheckout,
      record.received.commonDirectory,
    ],
    [record.received.repository, record.resolved.checkoutRoot, record.resolved.commonDirectory],
  ];
  return placesHeld(places, placements);
}

/** The Git-host request one saved Push request asks the worker to reconcile. */
export function replPushEffectRequest(inputs: GitPushInputs): {
  readonly kind: string;
  readonly inputs: Json;
  readonly naturalKey: Json;
} {
  return {
    kind: GIT_PUSH,
    inputs: gitPushInputsJson(inputs),
    naturalKey: gitPushNaturalKeyJson({
      repository: inputs.repository,
      remote: inputs.remote,
      destinationRef: inputs.destinationRef,
    }),
  };
}

/** The name the worker publishes one saved request's outcome under. */
export function replPushOutcomeName(record: ReplPushRequestRecord): Operation<string> {
  return gitHostRequestFingerprint({
    identity: { runId: record.owner, expansionId: record.site },
    ...replPushEffectRequest(record.resolved.inputs),
  });
}

/** The Git-host request one saved pull-request request asks to reconcile. */
export function replPullRequestEffectRequest(inputs: PullRequestInputs): {
  readonly kind: string;
  readonly inputs: Json;
  readonly naturalKey: Json;
} {
  return {
    kind: PULL_REQUEST,
    inputs: pullRequestInputsJson(inputs),
    naturalKey: pullRequestNaturalKeyJson(pullRequestNaturalKey(inputs)),
  };
}

/** The name the worker publishes one saved pull-request outcome under. */
export function replPullRequestOutcomeName(
  record: ReplPullRequestRequestRecord,
): Operation<string> {
  return gitHostRequestFingerprint({
    identity: { runId: record.owner, expansionId: record.site },
    ...replPullRequestEffectRequest(record.resolved.inputs),
  });
}

/**
 * One saved request waiting for the host's answer, of either retained kind.
 *
 * An entry retains two external protocols now, and a failed Git-host envelope
 * names neither: a refusal retains no request of its own. So the queue holds
 * what was actually asked, in order, and an outcome is paired with the request
 * standing before it rather than with whichever protocol a reader assumed.
 */
type ReplPendingRequest =
  | { readonly kind: "push"; readonly record: ReplPushRequestRecord }
  | { readonly kind: "pull-request"; readonly record: ReplPullRequestRequestRecord };

/** The name the worker would publish this pending request's outcome under. */
function pendingOutcomeName(pending: ReplPendingRequest): Operation<string> {
  return pending.kind === "push"
    ? replPushOutcomeName(pending.record)
    : replPullRequestOutcomeName(pending.record);
}

/** The Git-host kind this pending request asks the worker to reconcile. */
function pendingKind(pending: ReplPendingRequest): string {
  return pending.kind === "push" ? GIT_PUSH : PULL_REQUEST;
}

/** The site the pending request was made at. */
function pendingSite(pending: ReplPendingRequest): string {
  return pending.record.site;
}

/**
 * One acknowledged successful publication, with the provenance that produced it.
 *
 * The pair rather than the receipt alone, because a receipt says what the host
 * holds and says nothing about which checkout asked for it. What authorizes an
 * entry's pull request is the saved request beside the outcome: its resolved
 * checkout root, common directory and exact head commit.
 */
export interface ReplAcknowledgedPush {
  readonly request: ReplPushRequestRecord;
  readonly record: GitHostReconciliationRecord;
}

/**
 * What one entry's retained history holds, once it has been admitted.
 *
 * `pushes` is in physical journal outcome order, which is the order the
 * publications actually acknowledged in. Sibling coroutines restoring in
 * another order cannot change it, because this is a reading of the stream
 * rather than of a schedule.
 */
export interface ReplRetainedPublications {
  readonly pushes: readonly ReplAcknowledgedPush[];
}

/** The three words a Push outcome may fail under, as the journal holds them. */
const CLOSED_FAILURES: ReadonlySet<string> = new Set([
  "GitHostConflictError",
  "GitHostAmbiguousError",
  "GitHostUnavailableError",
]);

/**
 * Hold this entry's retained publication history to what this host can read.
 *
 * `retained` is the exact snapshot canonical execution admitted, which for an
 * entry is its own segment. Records of other features and other durable types
 * are not this reader's business and are passed over.
 */
export function* admitReplPushHistory(
  owner: string,
  retained: readonly DurableEvent[],
): Operation<void> {
  yield* walkReplRetainedPublications(owner, retained);
}

/**
 * The same admission, answering with the publications it validated.
 *
 * One walk serves both consumers deliberately. An entry's pull request is
 * authorized by its own acknowledged Push, and a second reader of this history
 * would be a second pairing algorithm that could disagree with the one
 * admission already performed. So the proof reads what admission validated,
 * and nothing is paired twice.
 */
export function* walkReplRetainedPublications(
  owner: string,
  retained: readonly DurableEvent[],
): Operation<ReplRetainedPublications> {
  /** Every place a successful placement record before this point described. */
  const placements: ReplPushPlacement[] = [];
  /** Per coroutine, the requests no outcome has answered yet. */
  const pending = new Map<string, ReplPendingRequest[]>();
  /** Per coroutine, whether an outcome has already answered something. */
  const answered = new Map<string, ReplPendingRequest[]>();
  /** Acknowledged successful publications, in physical outcome order. */
  const pushes: ReplAcknowledgedPush[] = [];

  for (const event of retained) {
    if (event.type !== "yield") {
      continue;
    }
    const type = event.description.type;
    if (type === REPL_REPOSITORY_PLACEMENT) {
      remember(placements, event);
      continue;
    }
    if (type === REPL_REPOSITORY_PUSH_REQUEST) {
      const record = yield* admitRequest(owner, event, placements);
      queue(pending, event.coroutineId).push({ kind: "push", record });
      continue;
    }
    if (type === REPL_REPOSITORY_PULL_REQUEST_REQUEST) {
      const record = yield* admitPullRequestRequest(owner, event, placements);
      queue(pending, event.coroutineId).push({ kind: "pull-request", record });
      continue;
    }
    if (type !== GIT_HOST_EFFECT) {
      continue;
    }
    const acknowledged = yield* admitOutcome(owner, event, pending, answered);
    if (acknowledged !== undefined) {
      pushes.push(acknowledged);
    }
  }
  return { pushes };
}

/** Remember one successful placement's parsed facts, or pass over the record. */
function remember(placements: ReplPushPlacement[], event: DurableEvent): void {
  if (event.type !== "yield" || event.result.status !== "ok") {
    return;
  }
  // The placement admission beside this one owns whether a placement record is
  // readable at all. What is wanted here is only the places a readable one
  // describes, so an unreadable record contributes nothing and is refused
  // there rather than twice.
  const record = parseReplPlacementRecord(event.result.value);
  if (record === undefined || !record.outcome.ok) {
    return;
  }
  const placement = record.outcome.value;
  placements.push({
    identity: placement.identity,
    checkoutRoot: placement.checkoutRoot,
    commonDirectory: placement.commonDirectory,
  });
}

function queue(
  queues: Map<string, ReplPendingRequest[]>,
  coroutineId: string,
): ReplPendingRequest[] {
  const existing = queues.get(coroutineId);
  if (existing !== undefined) {
    return existing;
  }
  const created: ReplPendingRequest[] = [];
  queues.set(coroutineId, created);
  return created;
}

/** One saved request, held to this version, this owner, its name and its places. */
function* admitRequest(
  owner: string,
  event: Yield,
  placements: readonly ReplPushPlacement[],
): Operation<ReplPushRequestRecord> {
  if (event.result.status !== "ok") {
    // A request publication has no failure side: its outcome is the appended
    // record itself, so a failed envelope under this type is not a record this
    // host ever wrote.
    throw malformed();
  }
  const payload = event.result.value;
  const stated = statedReplRecordVersion(payload);
  if (stated !== undefined && stated !== REPL_REPOSITORY_VERSION) {
    throw refusal(
      "unknown-version",
      `a ${REPL_REPOSITORY_PUSH_REQUEST} record states version ${stated}, and this host ` +
        `implements version ${REPL_REPOSITORY_VERSION} only. Nothing is assumed about what the ` +
        "rest of it means.",
    );
  }
  const record = parseReplPushRequestRecord(payload);
  if (record === undefined) {
    throw malformed();
  }
  if (record.owner !== owner) {
    throw refusal(
      "foreign-owner",
      "a saved publication request in this entry's history was written under another owner, so " +
        "the branch it asked to publish was not asked for by this entry and its request is not " +
        "one this entry can present again.",
    );
  }
  if (event.description.name !== (yield* replPushRequestName(record))) {
    throw refusal(
      "request-fingerprint",
      "a saved publication request is journaled under a name that is not the name its own " +
        "request produces, so the record and the publication it claims to be do not match.",
    );
  }
  if (!replPushPlacesHeld(record, placements)) {
    throw refusal(
      "unknown-placement",
      "a saved publication request names a checkout no selection before it placed, so this " +
        "history does not say where the branch it published came from.",
    );
  }
  return record;
}

/**
 * One saved pull-request request, on the same terms as a saved Push.
 *
 * Its own name, this owner, this version and places this entry holds. The codec
 * beside it has already held the saved content to the inputs that were resolved
 * from it; what is asked here is whether this history says where the upsert was
 * asked for.
 */
function* admitPullRequestRequest(
  owner: string,
  event: Yield,
  placements: readonly ReplPushPlacement[],
): Operation<ReplPullRequestRequestRecord> {
  if (event.result.status !== "ok") {
    // A request publication has no failure side, for the reason a saved Push
    // has none: its outcome is the appended record itself.
    throw pullRequestMalformed();
  }
  const payload = event.result.value;
  const stated = statedReplRecordVersion(payload);
  if (stated !== undefined && stated !== REPL_REPOSITORY_VERSION) {
    throw refusal(
      "unknown-version",
      `a ${REPL_REPOSITORY_PULL_REQUEST_REQUEST} record states version ${stated}, and this host ` +
        `implements version ${REPL_REPOSITORY_VERSION} only. Nothing is assumed about what the ` +
        "rest of it means.",
    );
  }
  const record = parseReplPullRequestRequestRecord(payload);
  if (record === undefined) {
    throw pullRequestMalformed();
  }
  if (record.owner !== owner) {
    throw refusal(
      "foreign-owner",
      "a saved pull-request request in this entry's history was written under another owner, so " +
        "what it asked the Git host for was not asked for by this entry.",
    );
  }
  if (event.description.name !== (yield* replPullRequestRequestName(record))) {
    throw refusal(
      "request-fingerprint",
      "a saved pull-request request is journaled under a name that is not the name its own " +
        "request produces, so the record and the request it describes do not match.",
    );
  }
  if (!replPullRequestPlacesHeld(record, placements)) {
    throw refusal(
      "unknown-placement",
      "a saved pull-request request names a checkout no selection before it placed, so this " +
        "history does not say where the pull request was asked for.",
    );
  }
  return record;
}

/**
 * Whether every place a saved pull-request request names is one this entry
 * holds.
 *
 * The same three readings the Push request is held to: what the invocation
 * authenticated, what the live dispatch received, and what routing resolved.
 */
export function replPullRequestPlacesHeld(
  record: ReplPullRequestRequestRecord,
  placements: readonly ReplPushPlacement[],
): boolean {
  const places: readonly ReplRequestPlace[] = [
    [
      record.requested.place.repository,
      record.requested.place.selectionCheckout,
      record.requested.place.commonDirectory,
    ],
    [
      record.received.place.repository,
      record.received.place.selectionCheckout,
      record.received.place.commonDirectory,
    ],
    [
      record.received.place.repository,
      record.resolved.checkoutRoot,
      record.resolved.commonDirectory,
    ],
  ];
  return placesHeld(places, placements);
}

/**
 * One Git-host outcome, paired with the request it answers.
 *
 * Only this entry's own retained external work is this reader's business. A
 * successful Git-host record of a kind this entry does not retain belongs to a
 * protocol this feature does not own and is passed over; one naming another
 * owner is refused, because an entry's segment holds its own work and borrowing
 * somebody else's receipt is exactly what must not be possible.
 *
 * **A failed envelope names no kind, so the request before it says what it
 * answers.** A refusal retains no request of its own, and an entry now retains
 * two external protocols — so reading every failure as a publication would
 * consume a pull request's refusal as a Push. The pending request standing at
 * this coroutine's position is what the failure answers, whichever kind it is,
 * and the name it is journaled under still has to be the one that request
 * produces. A successful envelope is held to its own stated kind as well: an
 * answer of one kind standing where the other was asked for describes neither.
 *
 * Answers with the acknowledged pair when this outcome is a successful
 * publication, because that is what authorizes an entry's pull request.
 */
function* admitOutcome(
  owner: string,
  event: Yield,
  pending: Map<string, ReplPendingRequest[]>,
  answered: Map<string, ReplPendingRequest[]>,
): Operation<ReplAcknowledgedPush | undefined> {
  const settled = event.result.status === "ok" ? successOf(event.result.value) : undefined;
  if (event.result.status === "ok" && settled === undefined) {
    // A successful Git-host envelope this host cannot read as a reconciliation
    // record says nothing trustworthy about external work.
    throw refusal(
      "malformed-receipt",
      "a Git-host record in this entry's history is not one this host can read, so what it says " +
        "about work already published is unknown.",
    );
  }
  if (
    settled !== undefined &&
    settled.request.kind !== GIT_PUSH &&
    settled.request.kind !== PULL_REQUEST
  ) {
    // Another external protocol's record. This reader owns the two kinds an
    // entry retains, and a well-formed record of any other passes over.
    return undefined;
  }
  if (settled !== undefined && settled.request.identity.runId !== owner) {
    throw refusal(
      "foreign-owner",
      "a Git-host outcome in this entry's history was reconciled under another owner, so the " +
        "work it describes was not asked for by this entry.",
    );
  }

  const queued = pending.get(event.coroutineId) ?? [];
  const request = queued.pop();
  if (request === undefined) {
    const spent = answered.get(event.coroutineId) ?? [];
    throw spent.length > 0
      ? refusal(
          "duplicate-outcome",
          "a saved request in this entry's history is answered by more than one Git-host " +
            "outcome, so this history does not say which of them describes what was done.",
        )
      : refusal(
          "orphan-outcome",
          "a Git-host outcome in this entry's history stands where no saved request asked for " +
            "one, so this history does not say what was asked of the Git host.",
        );
  }
  queue(answered, event.coroutineId).push(request);

  if (settled !== undefined && settled.request.kind !== pendingKind(request)) {
    throw refusal(
      "malformed-receipt",
      "a Git-host outcome describes a different kind of external work than the saved request " +
        "standing before it asked for, so the two do not describe one effect.",
    );
  }
  if (event.description.name !== (yield* pendingOutcomeName(request))) {
    throw refusal(
      "request-fingerprint",
      "a Git-host outcome is journaled under a name that is not the name the request before " +
        "it produces, so the outcome and the request it answers do not match.",
    );
  }
  if (settled === undefined) {
    const failed = failureOf(event.result);
    if (failed === undefined || !CLOSED_FAILURES.has(failed)) {
      throw refusal(
        "malformed-receipt",
        "a refused Git-host effect is recorded under a condition this host has no word for, so " +
          "what it says about the work is unknown.",
      );
    }
    return undefined;
  }
  if (settled.request.identity.expansionId !== pendingSite(request)) {
    throw refusal(
      "foreign-owner",
      "a Git-host outcome names an invocation other than the one the request before it was " +
        "made at, so the two describe different effects.",
    );
  }
  const asked =
    request.kind === "push"
      ? replPushEffectRequest(request.record.resolved.inputs)
      : replPullRequestEffectRequest(request.record.resolved.inputs);
  if (
    canonicalJson(settled.request.inputs) !== canonicalJson(asked.inputs) ||
    canonicalJson(settled.request.naturalKey) !== canonicalJson(asked.naturalKey)
  ) {
    throw refusal(
      "malformed-receipt",
      "a Git-host outcome describes work other than the one the request before it asked for, " +
        "so this history does not say what was done.",
    );
  }
  if (request.kind === "push") {
    if (
      parseGitPushRecord(settled, pushExpectation(request.record.resolved.inputs)) === undefined
    ) {
      throw refusal(
        "malformed-receipt",
        "a publication outcome holds a result that is not the one a Push of that branch " +
          "produces, so what it says was published is unknown.",
      );
    }
    return { request: request.record, record: settled };
  }
  if (parsePullRequestRecord(settled, request.record.resolved.inputs) === undefined) {
    throw refusal(
      "malformed-receipt",
      "a pull-request outcome holds a result that is not the one an upsert of those inputs " +
        "produces, so what it says about the pull request is unknown.",
    );
  }
  return undefined;
}

/** The reconciliation record this retained value describes, or `undefined`. */
function successOf(value: unknown): GitHostReconciliationRecord | undefined {
  return parseGitHostReconciliationRecord(value);
}

/** The closed name a failed envelope carries, or `undefined` when it carries none. */
function failureOf(result: Result): string | undefined {
  return result.status === "err" ? result.error.name : undefined;
}

function pullRequestMalformed(): ReplPushHistoryError {
  return refusal(
    "malformed-record",
    `a ${REPL_REPOSITORY_PULL_REQUEST_REQUEST} record in this entry's history is not one this ` +
      "host can read, so what it says about work already asked for is unknown.",
  );
}

function malformed(): ReplPushHistoryError {
  return refusal(
    "malformed-record",
    `a ${REPL_REPOSITORY_PUSH_REQUEST} record in this entry's history is not one this host can ` +
      "read, so what it says about work already asked for is unknown.",
  );
}

function refusal(reason: ReplPushRefusal, sentence: string): ReplPushHistoryError {
  return new ReplPushHistoryError(reason, sentence);
}
