/**
 * The Deno host's typed answer delivery.
 *
 * Delivery reaches a run's file the same way storage does — the SHA-256 of the
 * public run id beneath the authorized root — and then does the least a durable
 * answer can be retained with. It takes no executor lock, so a run somebody is
 * about to resume, or is resuming right now, can still be answered; what serializes
 * the write is the connection and SQLite, not lifecycle authority.
 *
 * ## Everything is checked before anything is written
 *
 * The run has to be `suspended`, its stop reason has to name a retained
 * `suspension_request` event, and that event has to be the wait the caller
 * named. The value is then judged against the response schema that request
 * retained, and scanned for credentials. Only after all of that does a
 * transaction open — and it asks the same questions again, inside the
 * transaction, because everything above it was read from a snapshot somebody
 * else could have moved on from.
 *
 * A refusal therefore leaves the database byte-identical. Nothing here writes
 * on the way to saying no.
 */

import type { DatabaseSync } from "node:sqlite";
import { exists } from "@effectionx/fs";
import { Err, Ok, type Operation, type Result, scoped } from "effection";
import {
  createSecretScanner,
  type Json,
  prepareElicitation,
  SecretDetectedError,
  type SecretFinding,
  validateParsed,
} from "@executablemd/core";
import { serializeDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import {
  parseSuspensionRequest,
  suspensionRequestFingerprint,
  type WorkflowSuspensionRequest,
} from "../suspension/api.ts";
import { SUSPENSION_ANSWER } from "../suspension/answer.ts";
import {
  type WorkflowAnswerDelivery,
  WorkflowAnswerDeliveryError,
  type WorkflowAnswerRetention,
  WorkflowInputDelivery,
} from "../suspension/delivery.ts";
import { SUSPENSION_REQUEST } from "../suspension/suspend.ts";
import {
  WorkflowRequestError,
  WorkflowRunIdMismatchError,
  WorkflowRunNotFoundError,
  WorkflowStorageError,
} from "../storage/errors.ts";
import { canonicalJson, type WorkflowRunRecord } from "../storage/record.ts";
import { insertPendingAnswer, readRetainedAnswer } from "./answers.ts";
import type { RunConnection, RunTransaction, WorkflowRunConnections } from "./connections.ts";
import { useWorkflowRunConnections } from "./connections.ts";
import { readRunRow } from "./database.ts";
import { useHostConnections } from "./host-connections.ts";
import { readJournalEntries } from "./journal.ts";
import { workflowRunPath } from "./path.ts";
import { authorizedRoot, checkRunId } from "./provider.ts";
import { readTransaction } from "./reading.ts";
import { translateSqliteError, verifySchema } from "./schema.ts";

export interface WorkflowInputDeliveryOptions {
  /** The directory this host keeps runs in. Absolute, as storage requires. */
  readonly root: string;
}

/** Install typed answer delivery for the current scope and its descendants. */
export function* useWorkflowInputDelivery(options: WorkflowInputDeliveryOptions): Operation<void> {
  yield* installWorkflowInputDelivery(options, yield* useWorkflowRunConnections());
}

/** The same installation, over a registry the host already owns. */
export function* installWorkflowInputDelivery(
  options: WorkflowInputDeliveryOptions,
  connections: WorkflowRunConnections,
): Operation<void> {
  const root = authorizedRoot(options.root);
  yield* useHostConnections(connections);
  yield* WorkflowInputDelivery.around(
    {
      *deliver([request]) {
        return yield* deliverAnswer(root, connections, request);
      },
    },
    { at: "min" },
  );
}

/** A delivery whose every member has been checked rather than believed. */
interface CheckedDelivery {
  readonly runId: string;
  readonly suspensionId: string;
  readonly value: Json;
  readonly secretDetection: boolean;
}

/** The wait a run is at, read from what it retained. */
interface RetainedWait {
  readonly record: WorkflowRunRecord;
  readonly requestEventId: string;
  readonly request: WorkflowSuspensionRequest;
  readonly fingerprint: string;
}

function* deliverAnswer(
  root: string,
  connections: WorkflowRunConnections,
  request: WorkflowAnswerDelivery,
): Operation<Result<WorkflowAnswerRetention>> {
  const checked = checkDelivery(request);
  if (!checked.ok) {
    return checked;
  }
  const { runId, suspensionId, value, secretDetection } = checked.value;

  const path = workflowRunPath(root, runId);
  // Asked before opening: `node:sqlite` creates the file it is pointed at, and
  // a delivery that left an empty database behind would have invented the run
  // it failed to answer.
  if (!(yield* exists(path))) {
    return Err(new WorkflowRunNotFoundError(runId));
  }

  const connection = yield* connections.at(path);

  const waiting = yield* scoped(function* (): Operation<Result<RetainedWait>> {
    yield* connection.lock.hold();
    try {
      return Ok(
        readTransaction(connection.database, () =>
          retainedWait(connection, path, runId, suspensionId),
        ),
      );
    } catch (error) {
      return refusal(error, path);
    }
  });
  if (!waiting.ok) {
    return waiting;
  }

  const judged = yield* judgeAnswer(waiting.value, suspensionId, value);
  if (!judged.ok) {
    return judged;
  }

  if (secretDetection) {
    const scanned = yield* scanDelivery(waiting.value, suspensionId, value);
    if (!scanned.ok) {
      return scanned;
    }
  }

  return yield* scoped(function* (): Operation<Result<WorkflowAnswerRetention>> {
    yield* connection.lock.hold();
    try {
      return Ok(retain(connection, path, runId, suspensionId, value, waiting.value.fingerprint));
    } catch (error) {
      return refusal(error, path);
    }
  });
}

/**
 * The wait this run is at, or a refusal naming why it is not at one.
 *
 * Recognition first, so a file that is not this run's version-1 database is
 * refused as itself. Then the run's own account of why it stopped: a status of
 * `suspended` whose stop reason names a retained request event. Anything else —
 * a completed run, a cancelled one, a run stopped for a different reason, a
 * request event for another wait — is a run this value does not answer.
 */
function retainedWait(
  connection: RunConnection,
  path: string,
  runId: string,
  suspensionId: string,
): RetainedWait {
  const { database } = connection;
  verifySchema(database, path, connection.dofs);
  const record = readRunRow(database, path);
  if (record.runId !== runId) {
    throw new WorkflowRunIdMismatchError(runId, path);
  }
  if (record.status !== "suspended") {
    throw new WorkflowAnswerDeliveryError(
      `workflow run ${runId} is ${record.status}, and only a suspended run is waiting for an ` +
        "answer.",
    );
  }
  const reason = record.stopReason;
  if (reason === undefined || reason.kind !== "journal") {
    throw new WorkflowAnswerDeliveryError(
      `workflow run ${runId} is suspended without naming the request it is waiting at, so ` +
        "there is no wait to answer.",
    );
  }

  const entry = readJournalEntries(database).find(
    (candidate) => candidate.eventId === reason.eventId,
  );
  const event = entry?.event;
  if (
    entry === undefined ||
    event === undefined ||
    event.type !== "yield" ||
    event.description.type !== SUSPENSION_REQUEST ||
    event.description.name !== suspensionId
  ) {
    throw new WorkflowAnswerDeliveryError(
      `workflow run ${runId} is not waiting at ${suspensionId}. A run waits at one suspension ` +
        "at a time, and `xmd workflow status` names the request event it stopped on.",
    );
  }

  // Parsed rather than read: the retained description is reached through a
  // public durable operation, so what it holds is a claim about a request until
  // this boundary has walked it — and a schema nothing could validate against
  // must not be the schema a value is judged by.
  const request = parseSuspensionRequest({
    request: event.description.request,
    responseSchema: event.description.responseSchema,
  });

  const retained = readRetainedAnswer(database, suspensionId);
  if (retained !== undefined) {
    throw new WorkflowAnswerDeliveryError(
      retained.state === "pending"
        ? `workflow run ${runId} already has an answer waiting for ${suspensionId}. One value ` +
            "ends one wait; resume the run to deliver it."
        : `the wait ${suspensionId} in workflow run ${runId} has already been answered.`,
    );
  }

  return {
    record,
    requestEventId: entry.eventId,
    request,
    fingerprint: suspensionRequestFingerprint(request),
  };
}

/**
 * The value, judged by the schema the wait retained.
 *
 * The same compilation `<Elicit>` uses, so what a document may receive here is
 * exactly what it may receive there. The refusal names where the value went
 * wrong and never what it held: a diagnostic that quoted a rejected value would
 * publish it in a place nothing filters.
 */
function* judgeAnswer(
  waiting: RetainedWait,
  suspensionId: string,
  value: Json,
): Operation<Result<void>> {
  let issues;
  try {
    const prepared = yield* prepareElicitation(waiting.request.responseSchema, "workflow answer");
    issues = validateParsed(prepared.validate, value);
  } catch (error) {
    return Err(
      new WorkflowAnswerDeliveryError(
        `the response schema retained for ${suspensionId} cannot judge an answer: ` +
          (error instanceof Error ? error.message : String(error)),
      ),
    );
  }
  if (issues.length === 0) {
    return Ok();
  }
  const described = issues
    .map(
      (issue) => `${issue.instancePath === "" ? "the value" : issue.instancePath} ${issue.message}`,
    )
    .join("; ");
  return Err(
    new WorkflowAnswerDeliveryError(
      `the value offered to ${suspensionId} does not satisfy the response schema that wait ` +
        `retained: ${described}.`,
    ),
  );
}

/**
 * Cross the same gate a durable event crosses, before anything is retained.
 *
 * Secret detection is attached to journal persistence, and this value is
 * heading for both retained state and a journal event — so both are scanned,
 * in the framing each will have. A credential that reached a run's file has
 * already leaked, whatever the resume that would have published it does next.
 *
 * The scanner is created for this delivery and reclaimed with it, so its
 * fingerprints mean nothing outside this call and are not reported.
 */
function* scanDelivery(
  waiting: RetainedWait,
  suspensionId: string,
  value: Json,
): Operation<Result<void>> {
  const scanner = createSecretScanner();
  const findings: SecretFinding[] = [];
  for (const content of [
    canonicalJson({
      suspensionId,
      requestEventId: waiting.requestEventId,
      requestFingerprint: waiting.fingerprint,
      answer: value,
    }),
    serializeDurableEvent(answerEvent(suspensionId, value)),
  ]) {
    try {
      findings.push(...(yield* scanner.scan(content)));
    } catch (error) {
      return Err(
        new WorkflowAnswerDeliveryError(
          "secret detection could not scan this answer, so it was not retained: " +
            (error instanceof Error ? error.message : String(error)),
        ),
      );
    }
  }
  if (findings.length === 0) {
    return Ok();
  }
  return Err(new WorkflowAnswerDeliveryError(describeDetection(findings)));
}

/**
 * The event a resume would publish, for the scanner to read.
 *
 * Which coroutine reaches the wait is not known until an execution does, and
 * nothing delivered travels in that field — so it is left empty here. What is
 * being scanned is the description and the value, in the JSON framing the
 * journal stores them in.
 */
function answerEvent(suspensionId: string, value: Json): DurableEvent {
  return {
    type: "yield",
    coroutineId: "",
    description: { type: SUSPENSION_ANSWER, name: suspensionId, suspensionId },
    result: { status: "ok", value },
  };
}

/**
 * What was found, without what was matched.
 *
 * The rule and the position say enough to fix the data flow. The fingerprints
 * are keyed to a scanner that existed for this call alone, so reporting them
 * would say nothing, and the matched text is exactly what must not travel.
 */
function describeDetection(findings: readonly SecretFinding[]): string {
  const detected = new SecretDetectedError(findings);
  const where = findings
    .map((finding) => `${finding.ruleId} (${finding.messageId})`)
    .filter((description, index, all) => all.indexOf(description) === index)
    .join(", ");
  return (
    `${detected.name}: this answer was not retained because secret detection matched it: ` +
    `${where}. Neither the value nor the match is recorded. Disable detection for this ` +
    "delivery with --no-secret-detection only when the value is known not to be a credential."
  );
}

/**
 * Retain the pending answer, asking every question again inside the transaction.
 *
 * `BEGIN IMMEDIATE` takes the write lock before the re-read, so what this
 * commits was true at the moment it committed. A run that moved on — resumed,
 * cancelled, answered by somebody else — refuses here, and the transaction it
 * refuses inside wrote nothing.
 */
function retain(
  connection: RunConnection,
  path: string,
  runId: string,
  suspensionId: string,
  value: Json,
  fingerprint: string,
): WorkflowAnswerRetention {
  const { database } = connection;
  database.exec("BEGIN IMMEDIATE");
  let transaction: RunTransaction;
  try {
    transaction = connection.beginTransaction();
  } catch (error) {
    rollback(database);
    throw error;
  }
  try {
    const waiting = retainedWait(connection, path, runId, suspensionId);
    if (waiting.fingerprint !== fingerprint) {
      throw new WorkflowAnswerDeliveryError(
        `the request retained for ${suspensionId} changed while this answer was being judged, ` +
          "so the value was judged against a schema this run no longer waits on.",
      );
    }
    insertPendingAnswer(database, {
      suspensionId,
      requestEventId: waiting.requestEventId,
      requestFingerprint: waiting.fingerprint,
      answer: value,
      createdAt: new Date().toISOString(),
    });
    connection.validateTransaction(transaction);
    connection.finishTransaction(transaction);
    database.exec("COMMIT");
    return { runId, suspensionId };
  } catch (error) {
    if (transaction.open) {
      connection.finishTransaction(transaction);
    }
    rollback(database);
    throw error;
  }
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    return;
  }
}

const DELIVERY_MEMBERS = ["runId", "suspensionId", "value", "secretDetection"];

/**
 * The whole request, parsed as a closed shape before any member is read.
 *
 * The type describes what a caller meant; what arrives is whatever the language
 * allows. A suspension id is opaque and every character of it is part of it, so
 * the only thing asked of it is that it is a non-empty string this run could
 * have derived.
 */
function checkDelivery(offered: WorkflowAnswerDelivery): Result<CheckedDelivery> {
  if (typeof offered !== "object" || offered === null || Array.isArray(offered)) {
    return Err(new WorkflowRequestError("a delivery takes an object describing one answer."));
  }
  const names = new Set(Object.keys(offered));
  const missing = DELIVERY_MEMBERS.filter((name) => !names.has(name));
  if (missing.length > 0) {
    return Err(new WorkflowRequestError(`the delivery is missing ${missing.join(", ")}.`));
  }

  const runId = checkRunId(Reflect.get(offered, "runId"));
  if (!runId.ok) {
    return runId;
  }

  const suspensionId = Reflect.get(offered, "suspensionId");
  if (typeof suspensionId !== "string" || suspensionId === "") {
    return Err(
      new WorkflowRequestError(
        "a delivery names the wait it answers, and a suspension id is a non-empty string.",
      ),
    );
  }

  const secretDetection = Reflect.get(offered, "secretDetection");
  if (typeof secretDetection !== "boolean") {
    return Err(
      new WorkflowRequestError("a delivery says whether it crosses the secret gate, as a boolean."),
    );
  }

  const value = retainableJson(Reflect.get(offered, "value"));
  if (value === undefined) {
    return Err(
      new WorkflowRequestError(
        "an answer is retained in this run's storage, so it must be JSON this run can store.",
      ),
    );
  }

  return Ok({ runId: runId.value, suspensionId, value, secretDetection });
}

/** The value, if every part of it is JSON this run can retain. */
function retainableJson(value: unknown): Json | undefined {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (encoded === undefined) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(encoded);
  return isJson(parsed) ? parsed : undefined;
}

function isJson(value: unknown): value is Json {
  if (value === null || typeof value === "string" || typeof value === "number") {
    return true;
  }
  if (typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJson);
  }
  if (typeof value === "object") {
    return Object.values(value).every(isJson);
  }
  return false;
}

/**
 * Report a storage refusal as itself, and let anything else propagate.
 *
 * A failure this module did not classify is not an expected outcome, and
 * turning it into one would hand a caller a `Result` describing a defect.
 */
function refusal<T>(error: unknown, path: string): Result<T> {
  const translated = translateSqliteError(error, path);
  if (translated instanceof WorkflowStorageError) {
    return Err(translated);
  }
  throw translated;
}
