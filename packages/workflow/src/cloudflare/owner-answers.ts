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

import { parseDurableEvent, serializeDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { readRunRecord, type Row } from "../sqlite/rows.ts";
import { WorkflowRecordMalformedError } from "../storage/errors.ts";
import { parseJsonValue } from "../storage/members.ts";
import { canonicalJson } from "../storage/record.ts";
import { sightCredentials } from "../suspension/credentials.ts";
import { SUSPENSION_ANSWER, SUSPENSION_REQUEST } from "../suspension/effects.ts";
import { judgeAgainstSchema, requireJudgeableSchema } from "../suspension/judgment.ts";
import { CommandError } from "./commands.ts";
import { sha256Hex } from "./encoding.ts";
import { heldExecution } from "./private-schema.ts";
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

/**
 * The retained answer this acquisition may spend, if there is one.
 *
 * Reading retained input is part of ending a wait, so it takes the same
 * authority ending one does: the acquisition asking has to hold an open
 * execution, and the wait asked about has to be the one this run is standing
 * at, with the request this claim names. A socket that has begun nothing, or
 * whose execution has been settled, recovered or replaced, is told nothing —
 * not because the row is missing, but because reading it is not its to do.
 */
export function readClaimableAnswer(
  storage: OwnerStorage,
  runId: string,
  acquisitionId: string,
  claim: { readonly suspensionId: string; readonly requestEventId: string },
): OwnerRetainedAnswer | undefined {
  requireOpenExecution(storage, acquisitionId);
  // The request this claim names, read from the run's own history. Not the
  // stop reason: a run being resumed is running, and the wait it is replaying
  // toward is a published event rather than the reason it last stopped.
  requirePublishedRequest(storage, runId, claim);
  return readRetainedAnswer(storage, claim.suspensionId);
}

/**
 * The exact journal event this run published one wait's request as.
 *
 * A suspension identifier is derivable and the event it was published as is
 * not, so a claim names both and this requires them to describe one retained
 * event of this run's. A caller that guessed an identifier is asking about a
 * wait rather than claiming one.
 */
function requirePublishedRequest(
  storage: OwnerStorage,
  runId: string,
  claim: { readonly suspensionId: string; readonly requestEventId: string },
): void {
  readRunRecord(retainedRun(storage, runId));
  const row = storage.sql
    .exec("SELECT event_id, record FROM journal_events WHERE event_id = ?", claim.requestEventId)
    .toArray()[0];
  if (row === undefined) {
    throw new CommandError("wrong-suspension");
  }
  const event = readEvent(row);
  if (
    event.type !== "yield" ||
    event.description.type !== SUSPENSION_REQUEST ||
    event.description.name !== claim.suspensionId
  ) {
    throw new CommandError("wrong-suspension");
  }
}

/**
 * The execution this acquisition holds, or a refusal that it holds none.
 *
 * A socket is not an execution. What may read retained input and what may
 * publish an answer is the acquisition that began an execution the run has not
 * moved past — settled, recovered, or taken over by somebody else all end it.
 */
export function requireOpenExecution(storage: OwnerStorage, acquisitionId: string): string {
  const held = heldExecution(storage, acquisitionId);
  if (held === undefined) {
    throw new CommandError("wrong-execution");
  }
  const open = storage.sql
    .exec(
      "SELECT execution_id FROM document_executions WHERE execution_id = ? AND stopped_at IS NULL",
      held,
    )
    .toArray()[0];
  if (open === undefined) {
    throw new CommandError("wrong-execution");
  }
  return held;
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
 * This is the mutation boundary, so this is where the value is judged. The wait
 * is resolved from what the run itself retained, the schema that wait published
 * is the schema the value is judged by, and the gate the request selected is
 * applied — all of it here, under the write, with nothing taken from the
 * caller but the value and the choice. A run that moved on refuses, and the
 * transaction it refuses inside wrote nothing.
 *
 * A compatible repeat is not a second write. The same value against the same
 * wait, still answering the same retained request, re-observes the row that is
 * already there; anything else disagreeing is a conflict.
 */
export function retainAnswer(
  storage: OwnerStorage,
  runId: string,
  offered: {
    readonly suspensionId: string;
    readonly answer: string;
    readonly secretDetection: boolean;
  },
  now: string,
): { readonly runId: string; readonly suspensionId: string } {
  const waiting = readRetainedWait(storage, runId, offered.suspensionId);
  const fingerprint = fingerprintOf(waiting);

  judgeOffered(waiting, offered.answer);
  if (offered.secretDetection) {
    gateOffered(waiting, fingerprint, offered.answer);
  }

  const already = readRetainedAnswer(storage, offered.suspensionId);
  if (already !== undefined) {
    if (
      already.state === "pending" &&
      already.requestEventId === waiting.requestEventId &&
      already.requestFingerprint === fingerprint &&
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
    waiting.requestEventId,
    fingerprint,
    offered.answer,
    now,
  );
  return { runId: waiting.runId, suspensionId: offered.suspensionId };
}

/**
 * Judge the offered value against the schema this wait retained.
 *
 * The schema is walked before the value is looked at: one it cannot judge is
 * refused rather than partly applied, so a value this accepts is one every
 * constraint its wait published was actually checked against. A refusal names
 * where the value went wrong and never what it held.
 */
function judgeOffered(waiting: OwnerRetainedWait, answer: string): void {
  let value: Json;
  let schema: Json;
  try {
    value = retained(JSON.parse(answer));
    schema = retained(waiting.responseSchema);
  } catch {
    throw new CommandError("malformed-member");
  }
  try {
    requireJudgeableSchema(schema);
  } catch {
    // The wait published a schema this build cannot judge an answer against.
    // Retaining a value it could not check would be retaining an unjudged one.
    throw new CommandError("unjudgeable-schema");
  }
  if (judgeAgainstSchema(schema, value).length > 0) {
    throw new CommandError("answer-rejected");
  }
}

/**
 * Cross the credential gate, in both framings the value will be stored in.
 *
 * The retained row and the durable event a later execution would publish, the
 * same two the local host scans. What is refused is the kind that was seen;
 * neither the value nor the match is recorded or reported.
 */
function gateOffered(waiting: OwnerRetainedWait, fingerprint: string, answer: string): void {
  let value: Json;
  try {
    value = retained(JSON.parse(answer));
  } catch {
    throw new CommandError("malformed-member");
  }
  const framings = [
    canonicalJson({
      suspensionId: waiting.suspensionId,
      requestEventId: waiting.requestEventId,
      requestFingerprint: fingerprint,
      answer: value,
    }),
    serializeDurableEvent({
      type: "yield",
      coroutineId: "",
      description: {
        type: SUSPENSION_ANSWER,
        name: waiting.suspensionId,
        suspensionId: waiting.suspensionId,
      },
      result: { status: "ok", value },
    }),
  ];
  for (const framing of framings) {
    if (sightCredentials(framing).length > 0) {
      throw new CommandError("credential-detected");
    }
  }
}

/**
 * Hold one proposal's answer events to the consumption that authorizes them.
 *
 * The two are one act and this is where that is enforced, before anything is
 * written. A proposal appending an answer event without a consumption is
 * forging durable history: nothing authorized that value, and no retained state
 * moves with it. A proposal appending more than one answer event is ending more
 * than one wait inside a unit of work that describes ending one. Both refuse
 * whole.
 *
 * Ordinary journal events are not looked at. What is counted is exactly the
 * events that claim to end a wait.
 */
export function requireAnswerEventsAuthorized(
  events: readonly string[],
  consumption: { readonly suspensionId: string } | null,
): void {
  const claiming = events.filter((record) => isAnswerEvent(record));
  if (consumption === null) {
    if (claiming.length > 0) {
      throw new CommandError("answer-unauthorized");
    }
    return;
  }
  if (claiming.length !== 1) {
    throw new CommandError("answer-unauthorized");
  }
}

/**
 * Spend one retained answer, inside the commit that publishes it.
 *
 * The events this commit appends are what decides it. A consumption is admitted
 * only when the one answer event it carries is this wait's, carrying exactly
 * the value this owner retained — so a runner cannot publish one value and
 * spend the row for another, and cannot spend a row without publishing at all.
 * A row that is gone, already spent, or delivered against a different request
 * refuses, and the whole commit goes with it.
 */
export function consumeRetainedAnswer(
  storage: OwnerStorage,
  acquisitionId: string,
  consumption: {
    readonly suspensionId: string;
    readonly requestEventId: string;
    readonly requestFingerprint: string;
  },
  events: readonly string[],
  now: string,
): void {
  // Publishing an answer is ending a wait, which is the execution's to do. A
  // socket that has begun nothing, or whose execution the run has moved past,
  // spends nothing however well formed its proposal is.
  requireOpenExecution(storage, acquisitionId);
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

/** Whether one appended record claims to end a wait at all. */
function isAnswerEvent(record: string): boolean {
  const parsed = parseDurableEvent(record);
  if (!parsed.ok) {
    return false;
  }
  const event = parsed.value;
  return event.type === "yield" && event.description.type === SUSPENSION_ANSWER;
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
