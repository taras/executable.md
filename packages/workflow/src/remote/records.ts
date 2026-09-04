/**
 * Reading a workflow record that arrived over a connection.
 *
 * The owner is the same build and is trusted to be honest; it is not trusted to
 * be correct, and neither is the wire between them. A performed answer is an
 * answer the owner labelled performed — that is all it is — so nothing here
 * turns an `unknown` into a run record, a retrieval or a journal entry without
 * checking every member first.
 *
 * The parsers the local host holds its own rows to are the parsers used here.
 * Two readings of one record is how the two hosts would stop agreeing about
 * what a run is, and the second reading is always the more permissive one.
 *
 * A failure names the member and never the value. What crossed the connection
 * is retained history, and a record that does not parse is not a reason to
 * repeat what it held.
 */

import { parseDurableEvent } from "@executablemd/durable-streams";
import type { JournalEntry } from "../storage/api.ts";
import { parseWorkflowDefinition } from "../storage/definition.ts";
import {
  parseJsonObject,
  parseJsonValue,
  parseMembers,
  parseStringMember,
  requireMemberNames,
} from "../storage/members.ts";
import {
  type DefinitionRetrieval,
  type DocumentExecutionRecord,
  parseRunId,
  parseWorkflowRunStatus,
  parseWorkflowStopReason,
  type WorkflowRunRecord,
} from "../storage/record.ts";
import { SHA256 } from "../workspace/root-manifest.ts";

export class RemoteRecordError extends Error {
  override name = "RemoteRecordError";
}

function fail(reason: string, path: string): Error {
  return new RemoteRecordError(
    `the owner returned a malformed workflow record at ${path}: ${reason}`,
  );
}

function instant(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw fail("expected an instant", path);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw fail("expected an instant", path);
  }
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw fail("expected a positive whole number", path);
  }
  return value;
}

function rootId(value: unknown, path: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw fail("expected a Workspace root identity", path);
  }
  return value;
}

export function parseRemoteRunRecord(value: unknown): WorkflowRunRecord {
  const members = parseMembers(value, "$", fail);
  requireMemberNames(
    members,
    ["runId", "definition", "base", "props", "status", "stopReason", "createdAt", "updatedAt"],
    "$",
    fail,
  );
  const definition = parseWorkflowDefinition(members.get("definition"));
  if (!definition.ok) {
    throw fail("expected a workflow definition", "$.definition");
  }
  const base = parseStringMember(members, "base", "$", fail);
  if (base === "") {
    throw fail("expected a non-empty string", "$.base");
  }
  const record: WorkflowRunRecord = {
    runId: parseRunId(members.get("runId"), "$.runId", fail),
    definition: definition.value,
    base,
    props: parseJsonObject(members.get("props"), "$.props", fail),
    status: parseWorkflowRunStatus(members.get("status"), "$.status", fail),
    createdAt: instant(members.get("createdAt"), "$.createdAt"),
    updatedAt: instant(members.get("updatedAt"), "$.updatedAt"),
  };
  if (!members.has("stopReason")) {
    return Object.freeze(record);
  }
  return Object.freeze({
    ...record,
    stopReason: parseWorkflowStopReason(members.get("stopReason"), "$.stopReason", fail),
  });
}

export function parseRemoteRetrieval(value: unknown): DefinitionRetrieval | undefined {
  if (value === null) {
    return undefined;
  }
  const members = parseMembers(value, "$", fail);
  requireMemberNames(members, ["metadata", "revision", "updatedAt"], "$", fail);
  if (members.size !== 3) {
    throw fail("expected every retrieval member", "$ ");
  }
  return Object.freeze({
    metadata: parseJsonValue(members.get("metadata"), "$.metadata", fail),
    revision: positiveInteger(members.get("revision"), "$.revision"),
    updatedAt: instant(members.get("updatedAt"), "$.updatedAt"),
  });
}

export function parseRemoteJournalEntry(value: unknown): JournalEntry {
  const members = parseMembers(value, "$", fail);
  requireMemberNames(members, ["eventId", "record", "workspaceRootId"], "$", fail);
  if (members.size !== 3) {
    throw fail("expected every journal member", "$ ");
  }
  const eventId = parseStringMember(members, "eventId", "$", fail);
  if (eventId === "") {
    throw fail("expected a non-empty identity", "$.eventId");
  }
  const record = parseStringMember(members, "record", "$", fail);
  const event = parseDurableEvent(record);
  if (!event.ok) {
    throw fail("expected a durable event", "$.record");
  }
  return Object.freeze({
    eventId,
    event: event.value,
    workspaceRootId: rootId(members.get("workspaceRootId"), "$.workspaceRootId"),
  });
}

/**
 * One document execution, read out of a value nothing has checked.
 *
 * The shared rules the local host holds its own rows to, applied to what
 * arrived. A stopped execution has to carry its status, and a stop reason has
 * to agree with the way the record spells one — an execution that stopped for a
 * reason the shape does not admit is not a record this build can act on.
 */
export function parseRemoteExecution(value: unknown): DocumentExecutionRecord {
  const found = parseMembers(value, "$", fail);
  const executionId = parseStringMember(found, "executionId", "$", fail);
  if (executionId === "") {
    throw fail("expected a non-empty identity", "$.executionId");
  }
  const record: DocumentExecutionRecord = {
    executionId,
    startedAt: instant(found.get("startedAt"), "$.startedAt"),
  };
  if (!found.has("stoppedAt")) {
    return Object.freeze(record);
  }
  const stopped: DocumentExecutionRecord = {
    ...record,
    stoppedAt: instant(found.get("stoppedAt"), "$.stoppedAt"),
    stopStatus: parseWorkflowRunStatus(found.get("stopStatus"), "$.stopStatus", fail),
  };
  if (!found.has("stopReason")) {
    return Object.freeze(stopped);
  }
  return Object.freeze({
    ...stopped,
    stopReason: parseWorkflowStopReason(found.get("stopReason"), "$.stopReason", fail),
  });
}
