/**
 * Whether one entry's retained publication history may be continued at all.
 *
 * Three questions, and only three. **Integrity**: every saved Push request
 * parses, states this version, and is published under the name its own question
 * produces. **Ownership**: every request and every Push outcome names this
 * entry's owner, because the owner is what the durable name is derived from — a
 * record written under another one would replay under a name this entry never
 * presented. **Pairing**: an outcome stands at the position after the request it
 * answers, carries that request's own fingerprint, and reads back as a Push of
 * exactly what was asked.
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
 *
 * ## One reader for two external protocols
 *
 * An entry retains two kinds of Git-host work — publication and pull-request
 * upsert — and both settle through the same `git_host_effect` type. A failed
 * envelope names no kind, because a refusal retains no request of its own, so
 * nothing in the record itself says which protocol it belongs to. What says so
 * is the request standing before it in the same coroutine: that request's own
 * kind decides which worker name the outcome must carry, which inputs and
 * natural key it must describe, and which result codec must be able to read it.
 *
 * This is why there is one reader rather than two. Two readers that each passed
 * over the other's failures would each see an orphan where the other saw a
 * pair, and a Push-only reader handed a refused pull request would check it
 * against a publication name it never had. Classification belongs to the
 * pairing, and the pairing is in one place.
 *
 * A pull-request request is held to one thing publication is not: the entry
 * must already have published the head it names. That is what makes the pull
 * request this entry's own work rather than a statement about somebody else's
 * branch, and the publication it rests on has to be one this history actually
 * acknowledged before it.
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
} from "../composition/git-push-records.ts";
import {
  parsePullRequestRecord,
  PULL_REQUEST,
  pullRequestInputsJson,
  pullRequestNaturalKey,
  pullRequestNaturalKeyJson,
  type PullRequestInputs,
} from "../composition/pull-request-records.ts";
import { sameRepositoryIdentity, type RepositoryIdentity } from "../composition/selection.ts";
import { GIT_HOST_EFFECT } from "../git-host/effect-type.ts";
import {
  gitHostRequestFingerprint,
  parseGitHostReconciliationRecord,
} from "../git-host/records.ts";
import type { GitHostReconciliationRecord } from "../git-host/records.ts";
import { parseReplPlacementRecord, REPL_REPOSITORY_PLACEMENT } from "./placement-records.ts";
import {
  parseReplPushRequestRecord,
  replPushRequestName,
  REPL_REPOSITORY_PUSH_REQUEST,
  type ReplPushRequestRecord,
} from "./push-records.ts";
import type { RankedReplPublication } from "./publication-evidence.ts";
import {
  parseReplPullRequestRequestRecord,
  replPullRequestRequestName,
  REPL_REPOSITORY_PULL_REQUEST_REQUEST,
  type ReplPullRequestRequestRecord,
} from "./pull-request-records.ts";
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
  /** A settled outcome that is not the result its own request produces. */
  | "malformed-receipt"
  /** A saved pull request whose head no publication before it published. */
  | "unauthorized-pull-request";

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
  const places: readonly (readonly [RepositoryIdentity, string, string])[] = [
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
  return places.every(([identity, checkoutRoot, commonDirectory]) =>
    placements.some(
      (placement) =>
        placement.checkoutRoot === checkoutRoot &&
        placement.commonDirectory === commonDirectory &&
        sameRepositoryIdentity(placement.identity, identity),
    ),
  );
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

/** The three words a Git-host outcome may fail under, as the journal holds them. */
const CLOSED_FAILURES: ReadonlySet<string> = new Set([
  "GitHostConflictError",
  "GitHostAmbiguousError",
  "GitHostUnavailableError",
]);

/**
 * One saved request of either protocol, with the kind that classifies it.
 *
 * The pairing carries the kind so an outcome's own envelope does not have to.
 * A failed envelope says nothing about which protocol refused, and this is what
 * answers it.
 */
type ReplExternalRequest =
  | { readonly kind: typeof GIT_PUSH; readonly record: ReplPushRequestRecord }
  | { readonly kind: typeof PULL_REQUEST; readonly record: ReplPullRequestRequestRecord };

/**
 * Whether some publication before this point put this pull request's head
 * where the pull request says it is.
 *
 * The last relevant publication decides. A pull request naming head `B` is
 * authorized by a publication of `B` to its own branch, and an earlier
 * publication of `A` to that same branch does not authorize it — the branch
 * holds whatever was published to it last. Finding any exact match anywhere in
 * history would let a superseded publication keep authorizing work.
 *
 * Relevant includes the checkout. Both requests naming a placement this entry
 * authenticated says only that each was asked somewhere legitimate; what
 * authorizes this pull request is a publication from the checkout it actually
 * resolved in, because another of this entry's checkouts has its own branch of
 * that name holding its own commit.
 */
function publicationAuthorizes(
  record: ReplPullRequestRequestRecord,
  publications: readonly RankedReplPublication[],
): boolean {
  const inputs = record.resolved.inputs;
  const relevant = publications
    .filter(
      (publication) =>
        publication.branch === inputs.headBranch &&
        publication.origin === record.resolved.origin &&
        publication.checkoutRoot === record.resolved.checkoutRoot &&
        publication.commonDirectory === record.resolved.commonDirectory &&
        sameRepositoryIdentity(publication.repository, inputs.repository),
    )

    .sort((left, right) => left.rank - right.rank);
  const last = relevant.at(-1);
  return last !== undefined && last.sourceCommit === inputs.headSha;
}

/** The Git-host request one saved pull-request request asks the worker to reconcile. */
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

/** The name the worker publishes one saved pull-request request's outcome under. */
export function replPullRequestOutcomeName(
  record: ReplPullRequestRequestRecord,
): Operation<string> {
  return gitHostRequestFingerprint({
    identity: { runId: record.owner, expansionId: record.site },
    ...replPullRequestEffectRequest(record.resolved.inputs),
  });
}

/** The Git-host request one saved request of either protocol asks for. */
function effectRequestOf(request: ReplExternalRequest): {
  readonly kind: string;
  readonly inputs: Json;
  readonly naturalKey: Json;
} {
  return request.kind === GIT_PUSH
    ? replPushEffectRequest(request.record.resolved.inputs)
    : replPullRequestEffectRequest(request.record.resolved.inputs);
}

/** The name the worker publishes one saved request's outcome under. */
function outcomeNameOf(request: ReplExternalRequest): Operation<string> {
  return request.kind === GIT_PUSH
    ? replPushOutcomeName(request.record)
    : replPullRequestOutcomeName(request.record);
}

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
): Operation<readonly RankedReplPublication[]> {
  /** Every place a successful placement record before this point described. */
  const placements: ReplPushPlacement[] = [];
  /** Every publication acknowledged before this point, in that order. */
  const publications: RankedReplPublication[] = [];
  /** Per coroutine, the requests no outcome has answered yet. */
  const pending = new Map<string, ReplExternalRequest[]>();
  /** Per coroutine, the requests an outcome already answered. */
  const answered = new Map<string, ReplExternalRequest[]>();

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
      queue(pending, event.coroutineId).push({ kind: GIT_PUSH, record });
      continue;
    }
    if (type === REPL_REPOSITORY_PULL_REQUEST_REQUEST) {
      const record = yield* admitPullRequest(owner, event, placements, publications);
      queue(pending, event.coroutineId).push({ kind: PULL_REQUEST, record });
      continue;
    }
    if (type !== GIT_HOST_EFFECT) {
      continue;
    }
    yield* admitOutcome(owner, event, pending, answered, publications);
  }
  // The ordered publication facts this snapshot holds. None of them is usable
  // until execution reaches it; that is the publication memory's question, and
  // what this reader supplies is the order.
  return publications;
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
  queues: Map<string, ReplExternalRequest[]>,
  coroutineId: string,
): ReplExternalRequest[] {
  const existing = queues.get(coroutineId);
  if (existing !== undefined) {
    return existing;
  }
  const created: ReplExternalRequest[] = [];
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
 * One saved pull-request request, held to everything a publication request is
 * held to, and to the publication that authorizes it.
 *
 * The first four questions are the same as publication's, for the same
 * reasons. The fifth is this protocol's own: a pull request names a head, and
 * an entry may only name a head it published itself. A saved request whose head
 * no publication in this history put on that branch describes work this entry
 * cannot account for — which is exactly what a copied, forged or cross-entry
 * receipt would look like from here.
 */
function* admitPullRequest(
  owner: string,
  event: Yield,
  placements: readonly ReplPushPlacement[],
  publications: readonly RankedReplPublication[],
): Operation<ReplPullRequestRequestRecord> {
  if (event.result.status !== "ok") {
    throw malformedPullRequest();
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
    throw malformedPullRequest();
  }
  if (record.owner !== owner) {
    throw refusal(
      "foreign-owner",
      "a saved pull-request request in this entry's history was written under another owner, so " +
        "the pull request it asked for was not asked for by this entry and its request is not " +
        "one this entry can present again.",
    );
  }
  if (event.description.name !== (yield* replPullRequestRequestName(record))) {
    throw refusal(
      "request-fingerprint",
      "a saved pull-request request is journaled under a name that is not the name its own " +
        "request produces, so the record and the pull request it claims to be do not match.",
    );
  }
  if (!replPullRequestPlacesHeld(record, placements)) {
    throw refusal(
      "unknown-placement",
      "a saved pull-request request names a checkout no selection before it placed, so this " +
        "history does not say where the pull request it asked for came from.",
    );
  }
  if (!publicationAuthorizes(record, publications)) {
    throw refusal(
      "unauthorized-pull-request",
      "a saved pull-request request names a head this entry's history never published to that " +
        "branch, so the pull request it asked for was not this entry's own work to ask for.",
    );
  }
  return record;
}

/**
 * Whether every place a saved pull-request request names is one these
 * placements hold.
 *
 * The same three readings publication is checked on, against the same
 * placements: the selection the invocation authenticated, the selection the
 * live dispatch received, and the checkout routing resolved.
 */
function replPullRequestPlacesHeld(
  record: ReplPullRequestRequestRecord,
  placements: readonly ReplPushPlacement[],
): boolean {
  const places: readonly (readonly [RepositoryIdentity, string, string])[] = [
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
 * One Git-host outcome, paired with the request it answers.
 *
 * The request standing before it in the same coroutine is what says which
 * protocol it belongs to. A failed envelope names no kind, so nothing in the
 * record itself could; and a successful one naming a kind the pairing does not
 * expect describes different work than was asked for. An outcome naming another
 * owner is refused, because an entry's segment holds its own work and borrowing
 * somebody else's receipt is exactly what must not be possible.
 *
 * A successful record of a kind neither protocol here owns belongs to something
 * this reader does not retain, and is passed over without consuming a pairing.
 */
function* admitOutcome(
  owner: string,
  event: Yield,
  pending: Map<string, ReplExternalRequest[]>,
  answered: Map<string, ReplExternalRequest[]>,
  publications: RankedReplPublication[],
): Operation<void> {
  const settled = event.result.status === "ok" ? successOf(event.result.value) : undefined;
  if (event.result.status === "ok" && settled === undefined) {
    // A successful Git-host envelope this host cannot read as a reconciliation
    // record says nothing trustworthy about external work.
    throw refusal(
      "malformed-receipt",
      "a Git-host record in this entry's history is not one this host can read, so what it says " +
        "about work already done is unknown.",
    );
  }
  if (
    settled !== undefined &&
    settled.request.kind !== GIT_PUSH &&
    settled.request.kind !== PULL_REQUEST
  ) {
    // Another external protocol's record. This reader owns publication and
    // pull requests, and consumes no pairing for anything else.
    return;
  }
  if (settled !== undefined && settled.request.identity.runId !== owner) {
    throw refusal(
      "foreign-owner",
      "a Git-host outcome in this entry's history was reconciled under another owner, so the " +
        "work it describes was not done by this entry.",
    );
  }

  const queued = pending.get(event.coroutineId) ?? [];
  const request = queued.pop();
  if (request === undefined) {
    // Which of the two this is, is a question about *this* outcome rather than
    // about how much of the coroutine is already paired. With two protocols
    // settling through one durable type, a completed pair earlier in the same
    // coroutine is ordinary, and calling an orphan a duplicate because one
    // exists would describe a history that is not this one.
    let answeredTwice = false;
    for (const candidate of answered.get(event.coroutineId) ?? []) {
      if (event.description.name === (yield* outcomeNameOf(candidate))) {
        answeredTwice = true;
        break;
      }
    }
    throw answeredTwice
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

  if (event.description.name !== (yield* outcomeNameOf(request))) {
    throw refusal(
      "request-fingerprint",
      "a Git-host outcome is journaled under a name that is not the name the request before " +
        "it produces, so the outcome and the request it claims to answer do not match.",
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
    return;
  }
  if (settled.request.kind !== request.kind) {
    throw refusal(
      "malformed-receipt",
      "a Git-host outcome describes a different kind of work than the request before it asked " +
        "for, so this history does not say what was done.",
    );
  }
  if (settled.request.identity.expansionId !== request.record.site) {
    throw refusal(
      "foreign-owner",
      "a Git-host outcome names an invocation other than the one the request before it was " +
        "made at, so the two describe different work.",
    );
  }
  const asked = effectRequestOf(request);
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
  if (request.kind === GIT_PUSH) {
    const inputs = request.record.resolved.inputs;
    if (parseGitPushRecord(settled, pushExpectation(inputs)) === undefined) {
      throw refusal(
        "malformed-receipt",
        "a publication outcome holds a result that is not the one a Push of that branch " +
          "produces, so what it says was published is unknown.",
      );
    }
    // What this publication proved, for whichever pull request rests on it.
    // Remembered in acknowledgement order, because the last publication to a
    // destination is the one that decides what is on that branch.
    publications.push({
      site: request.record.site,
      rank: publications.length,
      repository: inputs.repository,
      origin: request.record.resolved.origin,
      checkoutRoot: request.record.resolved.checkoutRoot,
      commonDirectory: request.record.resolved.commonDirectory,
      branch: inputs.branch,
      destinationRef: inputs.destinationRef,
      sourceCommit: inputs.sourceCommit,
    });

    return;
  }
  if (parsePullRequestRecord(settled, request.record.resolved.inputs) === undefined) {
    throw refusal(
      "malformed-receipt",
      "a pull-request outcome holds a result that is not the one an upsert of that pull request " +
        "produces, so what it says exists is unknown.",
    );
  }
}

/** The reconciliation record this retained value describes, or `undefined`. */
function successOf(value: unknown): GitHostReconciliationRecord | undefined {
  return parseGitHostReconciliationRecord(value);
}

/** The closed name a failed envelope carries, or `undefined` when it carries none. */
function failureOf(result: Result): string | undefined {
  return result.status === "err" ? result.error.name : undefined;
}

function malformed(): ReplPushHistoryError {
  return refusal(
    "malformed-record",
    `a ${REPL_REPOSITORY_PUSH_REQUEST} record in this entry's history is not one this host can ` +
      "read, so what it says about work already asked for is unknown.",
  );
}

function malformedPullRequest(): ReplPushHistoryError {
  return refusal(
    "malformed-record",
    `a ${REPL_REPOSITORY_PULL_REQUEST_REQUEST} record in this entry's history is not one this ` +
      "host can read, so what it says about work already asked for is unknown.",
  );
}

function refusal(reason: ReplPushRefusal, sentence: string): ReplPushHistoryError {
  return new ReplPushHistoryError(reason, sentence);
}
