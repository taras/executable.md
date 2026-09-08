/**
 * What one owner retains for the answers delivered to its durable waits.
 *
 * A retained answer is a row rather than a journal event, for the same reason
 * it is a row on a local host: the value arrives while nothing is running, and
 * it becomes history only when an execution reaches the wait it answers and
 * publishes it. Until then this is the whole of what the run holds.
 *
 * The row is written by the delivery plane, which takes no acquisition, and
 * spent by a commit, which requires the exact one. Both are decided here rather
 * than believed: the wait is read from the run's own account of why it stopped,
 * and the consumption is checked against the event the commit is appending.
 */

import { parseDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { readRunRecord, type Row } from "../sqlite/rows.ts";
import { WorkflowRecordMalformedError } from "../storage/errors.ts";
import { parseJsonValue } from "../storage/members.ts";
import { canonicalJson } from "../storage/record.ts";
import { SUSPENSION_ANSWER, SUSPENSION_REQUEST } from "../suspension/effects.ts";
import { CommandError } from "./commands.ts";
import { sha256Hex } from "./encoding.ts";
import { declaredObjects, holdsNoRun, isPristine, recognizeObject } from "./recognition.ts";
import { retainedText } from "./retained.ts";
import type { OwnerStorage } from "./storage.ts";

/**
 * What one wait retains, as this owner reads it.
 *
 * The request and its response schema travel as the retained description held
 * them — unparsed here, because judging a value against a schema is the
 * document runtime's work and this is not the document runtime. What this owner
 * decides is identity: which run, which wait, which event, and the fingerprint
 * a later retention is held to.
 */
export interface OwnerRetainedWait {
  readonly runId: string;
  readonly suspensionId: string;
  readonly requestEventId: string;
  readonly request: unknown;
  readonly responseSchema: unknown;
}

/** One answer this owner retains, whatever state it is in. */
export interface OwnerRetainedAnswer {
  readonly suspensionId: string;
  readonly requestEventId: string;
  readonly requestFingerprint: string;
  readonly answer: string;
  readonly state: "pending" | "consumed";
}

/**
 * The wait this run is standing at, or a refusal naming why it is not at one.
 *
 * Recognition first, so a store that is not this build's run refuses as itself.
 * Then the run's own account of why it stopped: a status of `suspended` whose
 * stop reason names a retained request event, and that event being the wait
 * being asked about. Anything else — a completed run, a cancelled one, a run
 * stopped for another reason, another wait's request — is a run this value does
 * not answer.
 */
export function readRetainedWait(
  storage: OwnerStorage,
  runId: string,
  suspensionId: string,
): OwnerRetainedWait {
  const record = readRunRecord(retainedRun(storage, runId));
  if (record.status !== "suspended") {
    throw new CommandError("not-suspended");
  }
  const reason = record.stopReason;
  if (reason === undefined || reason.kind !== "journal") {
    throw new CommandError("not-suspended");
  }
  const row = storage.sql
    .exec("SELECT event_id, record FROM journal_events WHERE event_id = ?", reason.eventId)
    .toArray()[0];
  if (row === undefined) {
    throw new CommandError("corrupt-journal");
  }
  const event = readEvent(row);
  if (
    event.type !== "yield" ||
    event.description.type !== SUSPENSION_REQUEST ||
    event.description.name !== suspensionId
  ) {
    throw new CommandError("wrong-suspension");
  }
  return {
    runId: record.runId,
    suspensionId,
    requestEventId: retainedText(row, "event_id"),
    request: event.description.request,
    responseSchema: event.description.responseSchema,
  };
}

/** What this run retains for one wait, if it retains anything. */
export function readRetainedAnswer(
  storage: OwnerStorage,
  suspensionId: string,
): OwnerRetainedAnswer | undefined {
  const row = storage.sql
    .exec(
      `SELECT suspension_id, request_event_id, request_fingerprint, answer, state
         FROM workflow_suspension_answers WHERE suspension_id = ?`,
      suspensionId,
    )
    .toArray()[0];
  return row === undefined ? undefined : parseRetainedAnswer(row);
}

/**
 * Retain one delivered answer, inside the caller's open transaction.
 *
 * Every fact the value was judged against is read again here, under the write
 * this transaction is about to make: a run that moved on — resumed, cancelled,
 * answered by somebody else, or waiting at a request that changed — refuses,
 * and the transaction it refuses inside wrote nothing.
 *
 * A compatible repeat is not a second write. The same value, against the same
 * wait, the same request event and the same fingerprint, re-observes the row
 * that is already there; anything else about it disagreeing is a conflict.
 */
export function retainAnswer(
  storage: OwnerStorage,
  runId: string,
  offered: {
    readonly suspensionId: string;
    readonly requestEventId: string;
    readonly requestFingerprint: string;
    readonly answer: string;
  },
  now: string,
): { readonly runId: string; readonly suspensionId: string } {
  const waiting = readRetainedWait(storage, runId, offered.suspensionId);
  if (waiting.requestEventId !== offered.requestEventId) {
    // The value was judged against a request published somewhere else in this
    // run's history, so it is not an answer to the wait this run is at.
    throw new CommandError("wrong-suspension");
  }
  if (fingerprintOf(waiting) !== offered.requestFingerprint) {
    throw new CommandError("stale-journal");
  }

  const already = readRetainedAnswer(storage, offered.suspensionId);
  if (already !== undefined) {
    if (
      already.state === "pending" &&
      already.requestEventId === offered.requestEventId &&
      already.requestFingerprint === offered.requestFingerprint &&
      already.answer === offered.answer
    ) {
      // The same delivery again, after its answer was lost. One decision, one
      // row, and nothing written a second time.
      return { runId: waiting.runId, suspensionId: offered.suspensionId };
    }
    throw new CommandError("duplicate-conflict");
  }

  storage.sql.exec(
    `INSERT INTO workflow_suspension_answers
      (suspension_id, request_event_id, request_fingerprint, answer, state, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)`,
    offered.suspensionId,
    offered.requestEventId,
    offered.requestFingerprint,
    offered.answer,
    now,
  );
  return { runId: waiting.runId, suspensionId: offered.suspensionId };
}

/**
 * Spend one retained answer, inside the commit that publishes it.
 *
 * The events this commit appends are what decides it. A consumption is admitted
 * only when exactly one of them is the answer Yield for this wait carrying
 * exactly the value this owner retained — so a runner cannot publish one value
 * and spend the row for another, and cannot spend a row without publishing at
 * all. A row that is gone, already spent, or delivered against a different
 * request refuses, and the whole commit goes with it.
 */
export function consumeRetainedAnswer(
  storage: OwnerStorage,
  consumption: {
    readonly suspensionId: string;
    readonly requestEventId: string;
    readonly requestFingerprint: string;
  },
  events: readonly string[],
  now: string,
): void {
  const spending = readRetainedAnswer(storage, consumption.suspensionId);
  if (spending === undefined || spending.state !== "pending") {
    throw new CommandError("answer-unavailable");
  }
  if (
    spending.requestEventId !== consumption.requestEventId ||
    spending.requestFingerprint !== consumption.requestFingerprint
  ) {
    throw new CommandError("answer-unavailable");
  }

  const published = events.filter((record) =>
    isAnswerFor(record, consumption.suspensionId, spending.answer),
  );
  if (published.length !== 1) {
    throw new CommandError("answer-unavailable");
  }

  storage.sql.exec(
    `UPDATE workflow_suspension_answers SET state = 'consumed', consumed_at = ?
       WHERE suspension_id = ? AND state = 'pending'`,
    now,
    consumption.suspensionId,
  );
  // Read back rather than counted: what matters is that the row this commit
  // spends is spent, and a statement's own report of how many rows it touched
  // is not the same statement as the one that says what the row now is.
  if (readRetainedAnswer(storage, consumption.suspensionId)?.state !== "consumed") {
    throw new CommandError("answer-unavailable");
  }
}

/**
 * Whether one appended record is this wait's answer, carrying this value.
 *
 * Parsed rather than matched as text: what a serialization spells is not what
 * it means, and the value is compared canonically so two encodings of one JSON
 * value are one answer.
 */
function isAnswerFor(record: string, suspensionId: string, answer: string): boolean {
  const parsed = parseDurableEvent(record);
  if (!parsed.ok) {
    return false;
  }
  const event = parsed.value;
  if (
    event.type !== "yield" ||
    event.description.type !== SUSPENSION_ANSWER ||
    event.description.name !== suspensionId
  ) {
    return false;
  }
  if (event.result === undefined || event.result.status !== "ok") {
    return false;
  }
  try {
    return canonicalJson(retained(event.result.value)) === answer;
  } catch {
    return false;
  }
}

/**
 * One retained value, held to the JSON rules storage holds every value to.
 *
 * The retained description and a published result are journal data: what they
 * hold is whatever was written, and canonicalizing something that is not JSON
 * would name a value nothing could store.
 */
function retained(value: unknown): Json {
  return parseJsonValue(value, "$", () => new CommandError("malformed-member"));
}

/** The run this owner holds, or a refusal that it holds another or none. */
function retainedRun(storage: OwnerStorage, runId: string): Row {
  if (isPristine(declaredObjects(storage)) || holdsNoRun(storage)) {
    // Nothing is stored here. Delivery names a run to answer, and answering a
    // run that does not exist is a fact about the run rather than damage — and
    // recognizing an empty store would report it as somebody else's.
    throw new CommandError("absent");
  }
  recognizeObject(storage);
  const row = storage.sql
    .exec(
      `SELECT run_id, definition, base, props, status, stop_reason_kind, stop_reason_code,
              stop_reason_event_id, created_at, updated_at FROM workflow_run`,
    )
    .toArray()[0];
  if (row === undefined) {
    throw new CommandError("absent");
  }
  if (readRunRecord(row).runId !== runId) {
    throw new CommandError("wrong-run");
  }
  return row;
}

function readEvent(row: Row): DurableEvent {
  const parsed = parseDurableEvent(retainedText(row, "record"));
  if (!parsed.ok) {
    throw new CommandError("corrupt-journal");
  }
  return parsed.value;
}

function parseRetainedAnswer(row: Row): OwnerRetainedAnswer {
  const state = retainedText(row, "state");
  if (state !== "pending" && state !== "consumed") {
    throw new WorkflowRecordMalformedError(
      "workflow_suspension_answers.state",
      "expected pending or consumed",
    );
  }
  return {
    suspensionId: retainedText(row, "suspension_id"),
    requestEventId: retainedText(row, "request_event_id"),
    requestFingerprint: retainedText(row, "request_fingerprint"),
    answer: retainedText(row, "answer"),
    state,
  };
}

/**
 * The fingerprint of the request this wait retained.
 *
 * Computed from the retained description exactly as the shared contract
 * computes it, so an owner and a runner that read the same wait derive the same
 * name for it.
 */
export function fingerprintOf(waiting: OwnerRetainedWait): string {
  return sha256Hex(
    canonicalJson({
      request: retained(waiting.request),
      responseSchema: retained(waiting.responseSchema),
    }),
  );
}
