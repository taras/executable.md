/**
 * Whether one entry's saved history may be continued at all.
 *
 * Two questions, and only two. **Integrity**: every record of this feature's
 * own types parses and is named by the request it carries. **Nothing else**: no
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
 * Hold this entry's saved history to what this host can read, or refuse.
 *
 * `saved` is the exact snapshot canonical execution admitted, which for an
 * entry is its own segment. Records of other features and of other durable
 * types are not this reader's business and are passed over; a record of *this*
 * feature's type that does not parse is, and refuses.
 */
export function* admitReplRepositoryHistory(saved: readonly DurableEvent[]): Operation<void> {
  for (const event of saved) {
    if (event.type !== "yield") {
      continue;
    }
    const type = event.description.type;
    if (type !== REPL_REPOSITORY_LOCAL && type !== REPL_REPOSITORY_SELECTION) {
      continue;
    }
    if (event.result.status !== "ok") {
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
    yield* admitLocal(payload, event.description.name);
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
    `a saved ${type} carries a fingerprint that is not the digest of the request beside it, ` +
      "so the request was changed after the work was saved and this history cannot say which of " +
      "the two the saved work belongs to.",
  );
}

function misnamed(type: string): ReplRepositoryHistoryError {
  return refusal(
    "request-fingerprint",
    `a saved ${type} is journaled under a name that is not the name its own request ` +
      "produces, so the record and the operation it claims to be do not match.",
  );
}

function refusal(reason: ReplRepositoryRefusal, sentence: string): ReplRepositoryHistoryError {
  return new ReplRepositoryHistoryError(reason, sentence);
}
