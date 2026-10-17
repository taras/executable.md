/**
 * Whether one entry's retained history may be continued at all.
 *
 * Two questions, and only two. **Integrity**: every record of this feature's
 * own types — the file work, the ambient routing, the placements, the local Git
 * transitions and the local Git observations — parses and is named by the
 * request it carries. **Nothing else**: no
 * checkout is inspected, no saved path is compared with the live one, and no
 * result is handed out — replaying a completed operation is the durable engine's
 * own positional matching, and this runs before any of it.
 *
 * Which entry a record belongs to is not asked here, because it is not this
 * reader's question: an entry executes against its own `EntrySegmentStream`
 * range, so the only records reaching this snapshot are the ones that range
 * holds. A second label inside the record would be a second answer to a
 * question the stream has already answered.
 *
 * A history that disagrees with the directory it was recorded in is an ordinary
 * situation rather than a refusal. The person reading the screen resolves that.
 * What is refused is a history this host cannot read as its own, because a
 * record whose request was changed after the work was saved would let a saved
 * result answer a question nobody asked.
 *
 * Repeated equal names are valid. One entry may write the same file with the
 * same content twice, and those are two records at two ordered positions; a
 * reader that deduplicated them by name would refuse a document that is allowed.
 */

import { StaleInputError } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import type { Operation } from "effection";
import {
  parseReplLocalRecord,
  parseReplSelectionRecord,
  replLocalFingerprint,
  replLocalRecordName,
  replSelectionFingerprint,
  replSelectionRecordName,
  REPL_REPOSITORY_LOCAL,
  REPL_REPOSITORY_SELECTION,
  REPL_REPOSITORY_VERSION,
  statedReplRecordVersion,
} from "./records.ts";
import {
  parseReplPlacementRecord,
  replPlacementFingerprint,
  replPlacementRecordName,
  REPL_REPOSITORY_PLACEMENT,
} from "./placement-records.ts";
import {
  parseReplGitRecord,
  replGitFingerprint,
  replGitRecordName,
  REPL_REPOSITORY_GIT,
} from "./git-records.ts";
import {
  parseReplObservationRecord,
  replObservationFingerprint,
  replObservationRecordName,
  REPL_REPOSITORY_OBSERVATION,
} from "./observation-records.ts";

/** The durable types this reader owns, and the only ones it reads. */
const OWNED: ReadonlySet<string> = new Set([
  REPL_REPOSITORY_LOCAL,
  REPL_REPOSITORY_SELECTION,
  REPL_REPOSITORY_PLACEMENT,
  REPL_REPOSITORY_GIT,
  REPL_REPOSITORY_OBSERVATION,
]);

/** Why a history cannot be continued. */
export type ReplRepositoryRefusal =
  /** A record of this feature's type that this version cannot read. */
  | "malformed-record"
  /** A record stating a version this host does not implement. */
  | "unknown-version"
  /** A record whose name is not the name of the request it carries. */
  | "request-fingerprint";

/**
 * A history this host cannot continue from.
 *
 * Fatal by construction: it extends `StaleInputError`, so it ends the attempt
 * rather than becoming a value a document can print away and carry on past.
 */
export class ReplRepositoryHistoryError extends StaleInputError {
  override name = "ReplRepositoryHistoryError";

  readonly reason: ReplRepositoryRefusal;

  constructor(reason: ReplRepositoryRefusal, sentence: string) {
    super(sentence);
    this.reason = reason;
  }
}

/**
 * Hold this entry's retained history to what this host can read, or refuse.
 *
 * `retained` is the exact snapshot canonical execution admitted, which for an
 * entry is its own segment. Records of other features and of other durable
 * types are not this reader's business and are passed over; a record of *this*
 * feature's type that does not parse is, and refuses.
 */
export function* admitReplRepositoryHistory(retained: readonly DurableEvent[]): Operation<void> {
  for (const event of retained) {
    if (event.type !== "yield") {
      continue;
    }
    const type = event.description.type;
    if (!OWNED.has(type)) {
      continue;
    }
    if (event.result.status !== "ok") {
      // A local Git operation's own refusals live inside its successful
      // payload, so a failed protocol envelope under that type is not a record
      // this host ever wrote — and what it says about work already done is
      // unknown. The three older types keep their existing policy, where a
      // non-ok envelope is the engine's own failure rather than theirs.
      if (type === REPL_REPOSITORY_GIT || type === REPL_REPOSITORY_OBSERVATION) {
        throw malformed(type);
      }
      continue;
    }
    const payload = event.result.value;
    const stated = statedReplRecordVersion(payload);
    if (stated !== undefined && stated !== REPL_REPOSITORY_VERSION) {
      throw refusal(
        "unknown-version",
        `a ${type} record states version ${stated}, and this host implements version ` +
          `${REPL_REPOSITORY_VERSION} only. Nothing is assumed about what the rest of it means.`,
      );
    }
    if (type === REPL_REPOSITORY_SELECTION) {
      yield* admitSelection(payload, event.description.name);
      continue;
    }
    if (type === REPL_REPOSITORY_PLACEMENT) {
      yield* admitPlacement(payload, event.description.name);
      continue;
    }
    if (type === REPL_REPOSITORY_GIT) {
      yield* admitGit(payload, event.description.name);
      continue;
    }
    if (type === REPL_REPOSITORY_OBSERVATION) {
      yield* admitObservation(payload, event.description.name);
      continue;
    }
    yield* admitLocal(payload, event.description.name);
  }
}

/**
 * Hold one recorded local Git operation to the request it carries.
 *
 * The same two questions the other records answer, over a record whose success
 * side is an operation result: a saved result that does not describe the request
 * beside it — another checkout's repository, another branch, another message, a
 * transition the operation does not make — does not parse, so it is refused here
 * rather than binding an object id on replay.
 *
 * It runs no `git` and opens nothing. Whether the branch a record names is still
 * there is not this reader's question and is not a question a continuation asks.
 */
function* admitGit(payload: unknown, name: string): Operation<void> {
  const record = parseReplGitRecord(payload);
  if (record === undefined) {
    throw malformed(REPL_REPOSITORY_GIT);
  }
  const fingerprint = yield* replGitFingerprint(record.request);
  if (record.fingerprint !== fingerprint) {
    throw changed(REPL_REPOSITORY_GIT);
  }
  if (name !== replGitRecordName({ operation: record.operation, fingerprint })) {
    throw misnamed(REPL_REPOSITORY_GIT);
  }
}

/**
 * Hold one recorded observation to the request it carries.
 *
 * The same two questions the other records answer, over a record whose success
 * side is one page: a saved page that does not describe the request beside it —
 * another query, another comparison, a continuation on another commit, more
 * records than the limit asked for — does not parse, so it is refused here
 * rather than binding a listing on replay.
 *
 * It runs no `git` and opens nothing. Whether the paths a record names are
 * still tracked is not this reader's question, and not a question a
 * continuation asks either.
 */
function* admitObservation(payload: unknown, name: string): Operation<void> {
  const record = parseReplObservationRecord(payload);
  if (record === undefined) {
    throw malformed(REPL_REPOSITORY_OBSERVATION);
  }
  const fingerprint = yield* replObservationFingerprint(record.request);
  if (record.fingerprint !== fingerprint) {
    throw changed(REPL_REPOSITORY_OBSERVATION);
  }
  if (name !== replObservationRecordName({ operation: record.operation, fingerprint })) {
    throw misnamed(REPL_REPOSITORY_OBSERVATION);
  }
}

function* admitLocal(payload: unknown, name: string): Operation<void> {
  const record = parseReplLocalRecord(payload);
  if (record === undefined) {
    throw malformed(REPL_REPOSITORY_LOCAL);
  }
  const fingerprint = yield* replLocalFingerprint({
    operation: record.operation,
    request: record.request,
  });
  if (record.fingerprint !== fingerprint) {
    throw changed(REPL_REPOSITORY_LOCAL);
  }
  if (name !== replLocalRecordName({ operation: record.operation, fingerprint })) {
    throw misnamed(REPL_REPOSITORY_LOCAL);
  }
}

/**
 * Hold one recorded selection to the request it carries.
 *
 * The same two questions the other two records answer, over a record whose
 * request is larger: a placement states its kind, and a request parsed as that
 * kind is what the fingerprint and the name are recomputed from. A record whose
 * outcome states a managed root for a checkout nothing placed — or omits one for
 * a checkout something did — does not parse, so it is refused here rather than
 * binding a path on replay.
 *
 * It opens nothing. Whether the checkout a placement names is still there is
 * not this reader's question and is not a question a continuation asks.
 */
function* admitPlacement(payload: unknown, name: string): Operation<void> {
  const record = parseReplPlacementRecord(payload);
  if (record === undefined) {
    throw malformed(REPL_REPOSITORY_PLACEMENT);
  }
  const fingerprint = yield* replPlacementFingerprint(record.request);
  if (record.fingerprint !== fingerprint) {
    throw changed(REPL_REPOSITORY_PLACEMENT);
  }
  if (name !== replPlacementRecordName({ kind: record.kind, fingerprint })) {
    throw misnamed(REPL_REPOSITORY_PLACEMENT);
  }
}

function* admitSelection(payload: unknown, name: string): Operation<void> {
  const record = parseReplSelectionRecord(payload);
  if (record === undefined) {
    throw malformed(REPL_REPOSITORY_SELECTION);
  }
  const fingerprint = yield* replSelectionFingerprint({ cwd: record.cwd });
  if (name !== replSelectionRecordName({ fingerprint })) {
    throw misnamed(REPL_REPOSITORY_SELECTION);
  }
}

function malformed(type: string): ReplRepositoryHistoryError {
  return refusal(
    "malformed-record",
    `a ${type} record in this entry's history is not one this host can read, so what it says ` +
      "about work already done is unknown.",
  );
}

function changed(type: string): ReplRepositoryHistoryError {
  return refusal(
    "request-fingerprint",
    `a retained ${type} carries a fingerprint that is not the digest of the request beside it, ` +
      "so the request was changed after the work was saved and this history cannot say which of " +
      "the two the saved work belongs to.",
  );
}

function misnamed(type: string): ReplRepositoryHistoryError {
  return refusal(
    "request-fingerprint",
    `a retained ${type} is journaled under a name that is not the name its own request ` +
      "produces, so the record and the operation it claims to be do not match.",
  );
}

function refusal(reason: ReplRepositoryRefusal, sentence: string): ReplRepositoryHistoryError {
  return new ReplRepositoryHistoryError(reason, sentence);
}
