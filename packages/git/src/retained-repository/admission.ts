/**
 * What one entry's history holds about repository work, and whether it may be
 * continued at all.
 *
 * Two questions, and only two. **Integrity**: every record of this feature's
 * own types parses, belongs to this entry, and is named by the request it
 * carries. **Inputs**: which external calls this entry already resolved, so a
 * continuation asks the same question rather than resolving a new one.
 *
 * What this deliberately does *not* ask is what the checkout looks like. The
 * REPL's execution model replays recorded results and leaves the environment to
 * the person; a history that disagrees with the directory it was recorded in is
 * an ordinary situation, not a refusal. So there is no baseline to fold, no
 * frontier chain to walk, no lane to order and no expected state to compare.
 * Replay of a completed operation is the durable engine's own positional
 * matching, which is why nothing here hands out saved results.
 *
 * A history holding the experimental snapshot protocol's records is refused
 * before any effect runs. Those encodings are not readable here and are not
 * migrated: continuing from them would mean treating records this version never
 * wrote as results it could replay.
 */

import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";
import { StaleInputError } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import {
  parseReplRepositoryRequest,
  parseReplRepositoryResult,
  replRepositoryRecordName,
  REPL_REPOSITORY_REQUEST,
  REPL_REPOSITORY_RESULT,
  REPL_REPOSITORY_VERSION,
  retainedRepositoryRequestFingerprint,
  SUPERSEDED_RECORD_TYPES,
} from "./records.ts";
import type { ReplRepositoryRequest, ReplRepositoryResult } from "./records.ts";

/** Why a history cannot be continued. */
export type RetainedRepositoryRefusal =
  /** A record of this feature's type that this version cannot read. */
  | "malformed-record"
  /** A record stating a version this host does not implement. */
  | "unknown-version"
  /** A record belonging to another entry, in this entry's own segment. */
  | "foreign-owner"
  /** A record whose name is not the name of the request it carries. */
  | "request-fingerprint"
  /** Two records of one operation, which no single operation writes. */
  | "duplicate-record"
  /** The experimental snapshot protocol's records, which are not readable. */
  | "superseded-protocol";

/**
 * A history this host cannot continue from.
 *
 * Fatal by construction: it extends `StaleInputError`, so it ends the attempt
 * rather than becoming a value a document can print away and carry on from.
 */
export class RetainedRepositoryHistoryError extends StaleInputError {
  override name = "RetainedRepositoryHistoryError";

  readonly reason: RetainedRepositoryRefusal;

  constructor(reason: RetainedRepositoryRefusal, sentence: string) {
    super(sentence);
    this.reason = reason;
  }
}

/** Everything one entry's admitted history holds about repository work. */
export interface RetainedRepositoryHistory {
  readonly owner: string;
  /** Every completed local operation, in the order the journal holds them. */
  readonly results: readonly ReplRepositoryResult[];
  /** Every external call this entry resolved the inputs of. */
  readonly requests: readonly ReplRepositoryRequest[];
}

/** One record as it is read out of the history, before anything names it. */
type ReadRecord =
  | { readonly kind: "result"; readonly value: ReplRepositoryResult; readonly name: string }
  | { readonly kind: "request"; readonly value: ReplRepositoryRequest; readonly name: string };

/**
 * The repository work one entry's history holds, or why it cannot be continued.
 *
 * `retained` is the exact snapshot core admitted and `owner` is this entry's own
 * spelling. Records of other features and of other durable types are not this
 * reader's business and are passed over; a record of *this* feature's type that
 * does not parse is, and refuses.
 */
export function* admitRetainedRepositoryHistory(
  retained: readonly DurableEvent[],
  owner: string,
): Operation<Result<RetainedRepositoryHistory>> {
  const read = readRecords(retained);
  if (!read.ok) {
    return read;
  }

  const results: ReplRepositoryResult[] = [];
  const requests: ReplRepositoryRequest[] = [];
  const seen = new Set<string>();

  for (const record of read.value) {
    const value = record.value;
    if (value.owner !== owner) {
      return refuse(
        "foreign-owner",
        `a ${record.kind} record in this entry's own segment is retained under another entry's ` +
          "owner, so this history describes work this entry cannot answer for.",
      );
    }

    // The name and the content have to agree. A record whose request was
    // changed after it was written would otherwise replay under a name that no
    // longer describes it — which is the one way a saved result could answer a
    // question nobody asked.
    const fingerprint = yield* retainedRepositoryRequestFingerprint({
      owner: value.owner,
      site: value.site,
      operation: value.operation,
      selection: null,
      request: value.request,
    });
    if (value.fingerprint !== fingerprint) {
      return refuse(
        "request-fingerprint",
        `a retained ${record.kind} carries a fingerprint that is not the digest of the request ` +
          "beside it, so the request was changed after the work was saved and this history " +
          "cannot say which of the two the saved work belongs to.",
      );
    }
    const named = replRepositoryRecordName({
      phase: record.kind,
      owner: value.owner,
      fingerprint,
      operation: value.operation,
    });
    if (record.name !== named) {
      return refuse(
        "request-fingerprint",
        `a retained ${record.kind} is journaled under a name that is not the name its own ` +
          "request produces, so the record and the operation it claims to be do not match.",
      );
    }
    if (seen.has(record.name)) {
      return refuse(
        "duplicate-record",
        `this history holds two ${record.kind} records for one operation, and one operation ` +
          "writes one. Which of them a continuation would replay is not a question this host " +
          "answers by choosing.",
      );
    }
    seen.add(record.name);

    if (record.kind === "result") {
      results.push(record.value);
      continue;
    }
    requests.push(record.value);
  }

  return Ok(
    Object.freeze({
      owner,
      results: Object.freeze([...results]),
      requests: Object.freeze([...requests]),
    }),
  );
}

/** Every record of this feature's types, or the reason there is no reading them. */
function readRecords(retained: readonly DurableEvent[]): Result<readonly ReadRecord[]> {
  const records: ReadRecord[] = [];
  for (const event of retained) {
    if (event.type !== "yield") {
      continue;
    }
    const type = event.description.type;
    if (SUPERSEDED_RECORD_TYPES.includes(type)) {
      return refuse(
        "superseded-protocol",
        `this history holds a ${type} record, which the experimental snapshot protocol wrote ` +
          "and this host no longer reads. Its records are kept as they are rather than " +
          "reinterpreted as results this version never recorded, so this execution cannot be " +
          "continued here.",
      );
    }
    if (type !== REPL_REPOSITORY_RESULT && type !== REPL_REPOSITORY_REQUEST) {
      continue;
    }
    if (event.result.status !== "ok") {
      continue;
    }
    const payload = event.result.value;
    const stated = statedVersion(payload);
    if (stated !== undefined && stated !== REPL_REPOSITORY_VERSION) {
      return refuse(
        "unknown-version",
        `a ${type} record states version ${stated}, and this host implements version ` +
          `${REPL_REPOSITORY_VERSION} only. Nothing is assumed about what the rest of it means.`,
      );
    }
    const name = event.description.name;
    if (type === REPL_REPOSITORY_RESULT) {
      const result = parseReplRepositoryResult(payload);
      if (result === undefined) {
        return malformed(type);
      }
      records.push({ kind: "result", value: result, name });
      continue;
    }
    const request = parseReplRepositoryRequest(payload);
    if (request === undefined) {
      return malformed(type);
    }
    records.push({ kind: "request", value: request, name });
  }
  return Ok(Object.freeze(records));
}

/**
 * The version a payload states, read before its membership is decided.
 *
 * A record from a later version is told apart from a broken one, so the person
 * is told which of the two they have.
 */
function statedVersion(payload: unknown): number | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return undefined;
  }
  const read = Reflect.get(payload, "version");
  return typeof read === "number" && Number.isSafeInteger(read) ? read : undefined;
}

function malformed(type: string): Result<never> {
  return refuse(
    "malformed-record",
    `a ${type} record in this entry's history is not one this host can read, so what it says ` +
      "about work already done is unknown.",
  );
}

function refuse(reason: RetainedRepositoryRefusal, sentence: string): Result<never> {
  return Err(new RetainedRepositoryHistoryError(reason, sentence));
}
