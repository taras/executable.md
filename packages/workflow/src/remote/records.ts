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
import { admitLocator, locatorFingerprintOf } from "../composition/locator.ts";
import {
  parseRepositoryRecord,
  parseWorktreeRecord,
  type WorktreeRecord,
} from "../composition/records.ts";
import { type AgentSessionRecord, parseAgentSessionRecord } from "../storage/agent-session.ts";
import type { StoredRepository } from "../workspace/metadata.ts";

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
  // One of exactly two legal shapes. A record carrying a stop status without
  // having stopped, or an undeclared member, is a shape this build does not
  // understand — and reading it leniently would make a history that means one
  // thing here and another where it was written.
  const active = ["executionId", "startedAt"];
  const stopped = [...active, "stoppedAt", "stopStatus"];
  const declared = found.has("stoppedAt")
    ? found.has("stopReason")
      ? [...stopped, "stopReason"]
      : stopped
    : active;
  requireMemberNames(found, declared, "$", fail);
  if (found.size !== declared.length) {
    throw fail("expected exactly the members this shape declares", "$");
  }

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
  const halted: DocumentExecutionRecord = {
    ...record,
    stoppedAt: instant(found.get("stoppedAt"), "$.stoppedAt"),
    stopStatus: parseWorkflowRunStatus(found.get("stopStatus"), "$.stopStatus", fail),
  };
  if (!found.has("stopReason")) {
    return Object.freeze(halted);
  }
  return Object.freeze({
    ...halted,
    stopReason: parseWorkflowStopReason(found.get("stopReason"), "$.stopReason", fail),
  });
}

/**
 * One admitted invocation snapshot, as the runner is allowed to read it.
 *
 * The root and journal anchor travel with the mappings because they are one
 * fact, and the runner holds the whole answer to that: before a document runs,
 * the transaction it runs inside has to start from exactly this root and this
 * anchor.
 */
export interface RemoteInvocationSnapshot {
  readonly workspaceRootId: string;
  readonly journalEventId: string | null;
  readonly repositories: readonly StoredRepository[];
  readonly worktrees: readonly WorktreeRecord[];
  readonly agentSessions: readonly AgentSessionRecord[];
}

/** The most mapping entries one admitted snapshot may carry. */
const MAX_SNAPSHOT_ENTRIES = 256;

export function parseRemoteInvocationSnapshot(value: unknown): RemoteInvocationSnapshot {
  const found = parseMembers(value, "$", fail);
  requireMemberNames(
    found,
    ["workspaceRootId", "journalEventId", "repositories", "worktrees", "agentSessions"],
    "$",
    fail,
  );
  const workspaceRootId = parseStringMember(found, "workspaceRootId", "$", fail);
  if (!SHA256.test(workspaceRootId)) {
    throw fail("expected a Workspace root identity", "$.workspaceRootId");
  }
  const anchor = found.get("journalEventId");
  if (anchor !== null && (typeof anchor !== "string" || anchor === "")) {
    throw fail("expected a journal event identity or an explicit empty anchor", "$.journalEventId");
  }

  const repositories = list(found.get("repositories"), "$.repositories").map((entry, index) =>
    parseStoredRepository(entry, `$.repositories[${index}]`),
  );
  const worktrees = list(found.get("worktrees"), "$.worktrees").map((entry, index) =>
    admitted(parseWorktreeRecord(entry), `$.worktrees[${index}]`, "a Worktree"),
  );
  const agentSessions = list(found.get("agentSessions"), "$.agentSessions").map((entry, index) =>
    admitted(parseAgentSessionRecord(entry), `$.agentSessions[${index}]`, "an Agent session"),
  );

  if (repositories.length + worktrees.length + agentSessions.length > MAX_SNAPSHOT_ENTRIES) {
    throw fail("expected fewer retained mappings than one snapshot may carry", "$");
  }
  requireOrdered(
    repositories.map((stored) => stored.record.name),
    "$.repositories",
  );
  requireOrdered(
    worktrees.map((record) => `${record.repositoryName} ${record.name}`),
    "$.worktrees",
  );
  requireOrdered(
    agentSessions.map((record) => record.sessionKey),
    "$.agentSessions",
  );
  // Every Worktree names a Repository this snapshot also carries. A checkout
  // whose Repository is missing is not a state this run was ever in.
  const names = new Set(repositories.map((stored) => stored.record.name));
  for (const [index, record] of worktrees.entries()) {
    if (!names.has(record.repositoryName)) {
      throw fail(
        "expected a Worktree whose Repository this snapshot holds",
        `$.worktrees[${index}]`,
      );
    }
  }
  return Object.freeze({
    workspaceRootId,
    journalEventId: anchor === null ? null : anchor,
    repositories: Object.freeze(repositories),
    worktrees: Object.freeze(worktrees),
    agentSessions: Object.freeze(agentSessions),
  });
}

function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw fail("expected an array", path);
  }
  return value;
}

function admitted<T>(parsed: T | undefined, path: string, expectation: string): T {
  if (parsed === undefined) {
    throw fail(`expected ${expectation}`, path);
  }
  return parsed;
}

/**
 * Deterministic and without repeats, checked rather than assumed.
 *
 * The owner reads these in one order; a snapshot that arrived in another, or
 * twice under one name, is not the state it claims to describe — and a mapping
 * view built from it would answer differently depending on which copy it read.
 */
function requireOrdered(keys: readonly string[], path: string): void {
  for (const [index, key] of keys.entries()) {
    const previous = keys[index - 1];
    if (previous !== undefined && previous >= key) {
      throw fail("expected retained mappings in one deterministic order, without repeats", path);
    }
  }
}

function parseStoredRepository(value: unknown, path: string): StoredRepository {
  const found = parseMembers(value, path, fail);
  requireMemberNames(found, ["record", "locator"], path, fail);
  const locator = parseStringMember(found, "locator", path, fail);
  // Admitted by the same rule the local host admits one by, so a locator this
  // build would refuse to use never becomes one it reconciles against.
  if (admitLocator(locator) === undefined) {
    throw fail("expected a Repository locator this build admits", `${path}.locator`);
  }
  const record = admitted(
    parseRepositoryRecord(found.get("record")),
    `${path}.record`,
    "a Repository",
  );
  if (locatorFingerprintOf(locator) !== record.locatorFingerprint) {
    throw fail("expected a locator the record's fingerprint follows from", `${path}.locator`);
  }
  return Object.freeze({ record, locator });
}
