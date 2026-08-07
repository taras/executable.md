/**
 * Turning stored rows back into records.
 *
 * The database's CHECK constraints hold the shapes it was given, and a file on
 * disk can still be edited by anything with write access. So a row is parsed
 * exactly as a caller's argument is: every column is checked, and the record is
 * rebuilt from the checked columns rather than handed on because its shape
 * looked right.
 *
 * A failure names the column and never the value. Props and journal payloads
 * are retained history, and a row that does not parse is not a reason to print
 * what it held.
 */

import type { Json } from "@executablemd/durable-streams";
import { parseWorkflowDefinition, type WorkflowDefinition } from "../storage/definition.ts";
import { WorkflowRecordMalformedError } from "../storage/errors.ts";
import { describe, type Fail, type JsonObject, parseJsonValue } from "../storage/members.ts";
import {
  type DefinitionRetrieval,
  type DocumentExecutionRecord,
  parseWorkflowRunStatus,
  parseWorkflowStopReason,
  type WorkflowRunRecord,
  type WorkflowRunStatus,
  type WorkflowStopReason,
} from "../storage/record.ts";

/** One row as SQLite hands it back. */
export type Row = Record<string, unknown>;

/** The three columns a stop reason occupies. */
export interface StopReasonColumns {
  readonly kind: string | null;
  readonly code: string | null;
  readonly eventId: string | null;
}

function failure(location: string): Fail {
  return (reason: string, path: string) =>
    new WorkflowRecordMalformedError(path === "$" ? location : `${location} ${path}`, reason);
}

function text(row: Row, column: string, table: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new WorkflowRecordMalformedError(
      `${table}.${column}`,
      `expected text, found ${describe(value)}`,
    );
  }
  return value;
}

function optionalText(row: Row, column: string, table: string): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new WorkflowRecordMalformedError(
      `${table}.${column}`,
      `expected text or null, found ${describe(value)}`,
    );
  }
  return value;
}

/**
 * Text that names something, which the empty string does not.
 *
 * `NOT NULL` says a column has text in it. It does not say the text is an
 * identity, and a run whose id is empty is addressable by nobody.
 */
function identifier(row: Row, column: string, table: string): string {
  const value = text(row, column, table);
  if (value === "") {
    throw new WorkflowRecordMalformedError(`${table}.${column}`, "expected a non-empty identity");
  }
  return value;
}

/** The exact spelling `toISOString()` produces, which is what storage writes. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * A moment, rather than any text at all.
 *
 * SQLite has no date type, so a timestamp column holds whatever text it was
 * given. Checking the shape here is what keeps "when did this run start" an
 * answer rather than a string that once looked like one.
 */
function instant(row: Row, column: string, table: string): string {
  const value = text(row, column, table);
  if (!INSTANT.test(value) || Number.isNaN(Date.parse(value))) {
    throw new WorkflowRecordMalformedError(`${table}.${column}`, "expected an ISO 8601 instant");
  }
  return value;
}

function integer(row: Row, column: string, table: string): number {
  const value = row[column];
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  throw new WorkflowRecordMalformedError(
    `${table}.${column}`,
    `expected an integer, found ${describe(value)}`,
  );
}

function json(row: Row, column: string, table: string): Json {
  const source = text(row, column, table);
  const location = `${table}.${column}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    // The thrown SyntaxError quotes the offending text, which is the one thing
    // a stored-record failure must not repeat.
    throw new WorkflowRecordMalformedError(location, "expected JSON");
  }
  return parseJsonValue(parsed, "$", failure(location));
}

/** A stored JSON column that must hold an object, such as normalized props. */
function jsonObject(row: Row, column: string, table: string): JsonObject {
  const value = json(row, column, table);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkflowRecordMalformedError(
      `${table}.${column}`,
      `expected an object, found ${describe(value)}`,
    );
  }
  return value;
}

/** The stop reason three columns describe, or none when they are all empty. */
export function readStopReason(row: Row, table: string): WorkflowStopReason | undefined {
  const kind = optionalText(row, "stop_reason_kind", table);
  if (kind === undefined) {
    return undefined;
  }
  const location = `${table}.stop_reason`;
  const code = optionalText(row, "stop_reason_code", table);
  const eventId = optionalText(row, "stop_reason_event_id", table);
  const value = kind === "host" ? { kind, code } : { kind, eventId };
  return parseWorkflowStopReason(value, "$", failure(location));
}

/** The three column values a stop reason binds to. */
export function stopReasonColumns(reason: WorkflowStopReason | undefined): StopReasonColumns {
  if (reason === undefined) {
    return { kind: null, code: null, eventId: null };
  }
  if (reason.kind === "host") {
    return { kind: "host", code: reason.code, eventId: null };
  }
  return { kind: "journal", code: null, eventId: reason.eventId };
}

/** The definition a stored column describes. */
export function readDefinition(row: Row, table: string): WorkflowDefinition {
  const location = `${table}.definition`;
  const parsed = parseWorkflowDefinition(json(row, "definition", table));
  if (!parsed.ok) {
    throw new WorkflowRecordMalformedError(location, parsed.error.message);
  }
  return parsed.value;
}

/** The run the singleton row describes. */
export function readRunRecord(row: Row): WorkflowRunRecord {
  const table = "workflow_run";
  const record: WorkflowRunRecord = {
    runId: identifier(row, "run_id", table),
    definition: readDefinition(row, table),
    base: text(row, "base", table),
    props: jsonObject(row, "props", table),
    status: readStatus(row, "status", table),
    createdAt: instant(row, "created_at", table),
    updatedAt: instant(row, "updated_at", table),
  };
  const stopReason = readStopReason(row, table);
  return Object.freeze(stopReason === undefined ? record : { ...record, stopReason });
}

/** The retrieval metadata the singleton row describes. */
export function readRetrieval(row: Row): DefinitionRetrieval {
  const table = "definition_retrieval";
  return Object.freeze({
    metadata: json(row, "metadata", table),
    revision: integer(row, "revision", table),
    updatedAt: instant(row, "updated_at", table),
  });
}

/** The document execution one ordered row describes. */
export function readDocumentExecution(row: Row): DocumentExecutionRecord {
  const table = "document_executions";
  const record: DocumentExecutionRecord = {
    executionId: identifier(row, "execution_id", table),
    startedAt: instant(row, "started_at", table),
  };
  const stoppedAt = optionalText(row, "stopped_at", table);
  if (stoppedAt === undefined) {
    return Object.freeze(record);
  }
  const stopReason = readStopReason(row, table);
  const stopped: DocumentExecutionRecord = {
    ...record,
    stoppedAt,
    stopStatus: readStatus(row, "stop_status", table),
  };
  return Object.freeze(stopReason === undefined ? stopped : { ...stopped, stopReason });
}

function readStatus(row: Row, column: string, table: string): WorkflowRunStatus {
  return parseWorkflowRunStatus(row[column], "$", failure(`${table}.${column}`));
}
