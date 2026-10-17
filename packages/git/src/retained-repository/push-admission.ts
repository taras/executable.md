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
  /** Every place a successful placement record before this point described. */
  const placements: ReplPushPlacement[] = [];
  /** Per coroutine, the requests no outcome has answered yet. */
  const pending = new Map<string, ReplPushRequestRecord[]>();
  /** Per coroutine, the requests an outcome already answered. */
  const answered = new Map<string, ReplPushRequestRecord[]>();

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
      queue(pending, event.coroutineId).push(record);
      continue;
    }
    if (type !== GIT_HOST_EFFECT) {
      continue;
    }
    yield* admitOutcome(owner, event, pending, answered);
  }
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
  queues: Map<string, ReplPushRequestRecord[]>,
  coroutineId: string,
): ReplPushRequestRecord[] {
  const existing = queues.get(coroutineId);
  if (existing !== undefined) {
    return existing;
  }
  const created: ReplPushRequestRecord[] = [];
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
 * One Git-host outcome, paired with the request it answers.
 *
 * Only this entry's own Push effects are this reader's business. A successful
 * Git-host record of another kind belongs to a protocol this feature does not
 * retain and is passed over; one naming another owner is refused, because an
 * entry's segment holds its own work and borrowing somebody else's receipt is
 * exactly what must not be possible.
 *
 * A failed envelope names no kind — a refusal retains no request of its own —
 * so every one of them in an entry's segment is read as a publication. That is
 * exactly what they are: publication is the one external protocol an entry
 * retains through this boundary, and the name the failure is journaled under
 * still has to be the one the request before it produces.
 */
function* admitOutcome(
  owner: string,
  event: Yield,
  pending: Map<string, ReplPushRequestRecord[]>,
  answered: Map<string, ReplPushRequestRecord[]>,
): Operation<void> {
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
  if (settled !== undefined && settled.request.kind !== GIT_PUSH) {
    // Another external protocol's record. This reader owns publication only.
    return;
  }
  if (settled !== undefined && settled.request.identity.runId !== owner) {
    throw refusal(
      "foreign-owner",
      "a publication outcome in this entry's history was reconciled under another owner, so the " +
        "work it describes was not published by this entry.",
    );
  }

  const queued = pending.get(event.coroutineId) ?? [];
  const request = queued.pop();
  if (request === undefined) {
    const spent = answered.get(event.coroutineId) ?? [];
    throw spent.length > 0
      ? refusal(
          "duplicate-outcome",
          "a publication request in this entry's history is answered by more than one Git-host " +
            "outcome, so this history does not say which of them describes what was published.",
        )
      : refusal(
          "orphan-outcome",
          "a publication outcome in this entry's history stands where no saved request asked for " +
            "one, so this history does not say what was asked of the Git host.",
        );
  }
  queue(answered, event.coroutineId).push(request);

  if (event.description.name !== (yield* replPushOutcomeName(request))) {
    throw refusal(
      "request-fingerprint",
      "a publication outcome is journaled under a name that is not the name the request before " +
        "it produces, so the outcome and the request it claims to answer do not match.",
    );
  }
  if (settled === undefined) {
    const failed = failureOf(event.result);
    if (failed === undefined || !CLOSED_FAILURES.has(failed)) {
      throw refusal(
        "malformed-receipt",
        "a refused publication is recorded under a condition this host has no word for, so what " +
          "it says about the branch is unknown.",
      );
    }
    return;
  }
  if (settled.request.identity.expansionId !== request.site) {
    throw refusal(
      "foreign-owner",
      "a publication outcome names an invocation other than the one the request before it was " +
        "made at, so the two describe different publications.",
    );
  }
  const asked = replPushEffectRequest(request.resolved.inputs);
  if (
    canonicalJson(settled.request.inputs) !== canonicalJson(asked.inputs) ||
    canonicalJson(settled.request.naturalKey) !== canonicalJson(asked.naturalKey)
  ) {
    throw refusal(
      "malformed-receipt",
      "a publication outcome describes a push other than the one the request before it asked " +
        "for, so this history does not say what was published.",
    );
  }
  if (parseGitPushRecord(settled, pushExpectation(request.resolved.inputs)) === undefined) {
    throw refusal(
      "malformed-receipt",
      "a publication outcome holds a result that is not the one a Push of that branch produces, " +
        "so what it says was published is unknown.",
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

function refusal(reason: ReplPushRefusal, sentence: string): ReplPushHistoryError {
  return new ReplPushHistoryError(reason, sentence);
}
