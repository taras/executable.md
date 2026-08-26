/**
 * The rows one run keeps for the answers delivered to its durable waits.
 *
 * A retained answer is a row rather than a journal event, because delivery and
 * execution are different operations. The value arrives while nothing is
 * running; it becomes history only when an execution reaches the wait it
 * answers and publishes it. Until then the row is what the run holds and the
 * only thing a later resume consults.
 *
 * Each row carries the identity of the wait it answers three ways over: the
 * suspension id it was delivered against, the exact journal event the request
 * was published as, and a fingerprint of the request and its response schema.
 * The fingerprint is what a resume compares — a run whose retained request at
 * that position is not the one the value was judged against is a run this
 * answer was never for.
 */

import type { DatabaseSync } from "node:sqlite";
import type { Json } from "@executablemd/durable-streams";
import { WorkflowRecordMalformedError } from "../storage/errors.ts";
import { describe, parseJsonValue } from "../storage/members.ts";
import { canonicalJson } from "../storage/record.ts";
import { reading } from "./reading.ts";

const SELECT_ANSWER = "SELECT * FROM workflow_suspension_answers WHERE suspension_id = ?";
const SELECT_ANSWERS = "SELECT * FROM workflow_suspension_answers ORDER BY suspension_id";
const INSERT_ANSWER = `INSERT INTO workflow_suspension_answers
  (suspension_id, request_event_id, request_fingerprint, answer, state, created_at)
  VALUES (?, ?, ?, ?, 'pending', ?)`;
const CONSUME_ANSWER = `UPDATE workflow_suspension_answers
  SET state = 'consumed', consumed_at = ?
  WHERE suspension_id = ? AND state = 'pending'`;

/** Whether a retained answer is still waiting to be published, or already was. */
export type RetainedAnswerState = "pending" | "consumed";

/** One delivered answer, as this run retains it. */
export interface RetainedAnswer {
  readonly suspensionId: string;
  readonly requestEventId: string;
  readonly requestFingerprint: string;
  readonly answer: Json;
  readonly state: RetainedAnswerState;
  readonly createdAt: string;
  readonly consumedAt: string | undefined;
}

/** What one delivery retains. */
export interface PendingAnswerInsertion {
  readonly suspensionId: string;
  readonly requestEventId: string;
  readonly requestFingerprint: string;
  readonly answer: Json;
  readonly createdAt: string;
}

/** The answer retained for this wait, whatever state it is in. */
export function readRetainedAnswer(
  database: DatabaseSync,
  suspensionId: string,
): RetainedAnswer | undefined {
  const row = reading(database, SELECT_ANSWER).get(suspensionId);
  return row === undefined ? undefined : parseRetainedAnswer(row);
}

/**
 * Every answer this run retains, in one deterministic order.
 *
 * What an export seals. Ordered by the wait each one answers rather than by
 * insertion, so the same retained state reads the same however SQLite would
 * have returned the rows.
 */
export function readAllRetainedAnswers(database: DatabaseSync): RetainedAnswer[] {
  return reading(database, SELECT_ANSWERS).all().map(parseRetainedAnswer);
}

/**
 * Retain one pending answer.
 *
 * The primary key is what refuses a second delivery for the same wait, so
 * duplicate and already-consumed deliveries are refused by the database rather
 * than by a check the caller could race.
 */
export function insertPendingAnswer(
  database: DatabaseSync,
  insertion: PendingAnswerInsertion,
): void {
  database
    .prepare(INSERT_ANSWER)
    .run(
      insertion.suspensionId,
      insertion.requestEventId,
      insertion.requestFingerprint,
      canonicalJson(insertion.answer),
      insertion.createdAt,
    );
}

/**
 * Mark this wait's retained answer consumed, and say whether it was this call
 * that did it.
 *
 * The state is part of the statement rather than something read first: a second
 * consumption changes no rows and is told so, which is how the publication that
 * commits with it stays the only one.
 */
export function consumeRetainedAnswer(
  database: DatabaseSync,
  suspensionId: string,
  consumedAt: string,
): boolean {
  const changes = database.prepare(CONSUME_ANSWER).run(consumedAt, suspensionId).changes;
  return Number(changes) === 1;
}

function parseRetainedAnswer(row: Record<string, unknown>): RetainedAnswer {
  return Object.freeze({
    suspensionId: text(row, "suspension_id"),
    requestEventId: text(row, "request_event_id"),
    requestFingerprint: text(row, "request_fingerprint"),
    answer: parseJsonValue(JSON.parse(text(row, "answer")), "$", answerFailure),
    state: state(row),
    createdAt: text(row, "created_at"),
    consumedAt: optionalText(row, "consumed_at"),
  });
}

function state(row: Record<string, unknown>): RetainedAnswerState {
  const value = text(row, "state");
  if (value !== "pending" && value !== "consumed") {
    throw new WorkflowRecordMalformedError(
      "workflow_suspension_answers.state",
      `expected pending or consumed, found ${describe(value)}`,
    );
  }
  return value;
}

function text(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== "string" || value === "") {
    throw new WorkflowRecordMalformedError(
      `workflow_suspension_answers.${column}`,
      `expected a non-empty string, found ${describe(value)}`,
    );
  }
  return value;
}

function optionalText(row: Record<string, unknown>, column: string): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) {
    return undefined;
  }
  return text(row, column);
}

function answerFailure(reason: string, path: string): Error {
  return new WorkflowRecordMalformedError(
    "workflow_suspension_answers.answer",
    `${reason} at ${path}`,
  );
}
