/**
 * The artifact's records, in both directions, and nothing that opens a file.
 *
 * One inventory is produced from a snapshot and one snapshot is produced from
 * an inventory, by the same module and against the same rules. That symmetry is
 * the point: the writer seals what this encoder produces and then reads its own
 * file back through this decoder, so a record the decoder would refuse can
 * never be sealed, and a record the encoder cannot produce can never be
 * accepted.
 *
 * Every record is parsed rather than asserted. The container's CHECK
 * constraints hold the shapes the writer gave it, and a file on disk can still
 * be edited by anything with write access — so a `.xmd` is read exactly as a
 * caller's argument is, member by member, and the value is rebuilt from the
 * checked members rather than handed on because its shape looked right.
 *
 * ## What the diagnostics may say
 *
 * The kind that failed and why, in this module's own words. Never the content:
 * an artifact holds whatever the run wrote into its Workspace, and a refusal
 * that quoted part of it would publish exactly what the file is being refused
 * for. That is also why the live Workspace parsers are called with a rejection
 * of this module's own — their default sentence names a run database and tells
 * an operator to restore it from a backup, which is advice about a different
 * kind of file.
 */

import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { parseDurableEvent } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { readEventSource } from "../../lifecycle/history.ts";
import type { InheritedEventProvenance } from "../../lifecycle/history.ts";
import {
  definitionComponents,
  definitionToJson,
  parseWorkflowDefinition,
} from "../../storage/definition.ts";
import type { WorkflowDefinition } from "../../storage/definition.ts";
import { XmdArtifactInventoryError, XmdArtifactRecordError } from "../../storage/errors.ts";
import {
  describe,
  type Fail,
  parseJsonObject,
  parseJsonValue,
  parseMembers,
  requireMemberNames,
} from "../../storage/members.ts";
import {
  parseRunId,
  parseWorkflowRunStatus,
  parseWorkflowStopReason,
} from "../../storage/record.ts";
import type {
  DocumentExecutionRecord,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowStopReason,
} from "../../storage/record.ts";
import type { RetainedAnswer, RetainedAnswerState } from "../answers.ts";
import type {
  RetainedBlob,
  RetainedManifest,
  RetainedRepository,
  RetainedWorktree,
} from "../fork-source.ts";
import { agentSessionKey } from "../workspace/agent-sessions.ts";
import type { AgentSessionRecord } from "../workspace/agent-sessions.ts";
import {
  compareUtf8,
  parseWorkspaceManifest,
  sha256,
  type StoredWorkspaceRoot,
  toHex,
  workspaceRoot,
  type WorkspaceRootManifest,
} from "../workspace/manifest.ts";
import { decodeDofsManifest } from "../workspace/root.ts";
import type { DofsManifest } from "../workspace/root.ts";
import { canonicalJsonBytes, canonicalJsonText, entryKey } from "./manifest.ts";
import type {
  XmdArtifactContentEntry,
  XmdArtifactContents,
  XmdArtifactDefinitionClosure,
  XmdArtifactDefinitionComponent,
  XmdArtifactDefinitionRoot,
  XmdArtifactForkLineage,
  XmdArtifactFrontier,
  XmdArtifactJournalRow,
} from "./types.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const SHA256 = /^[0-9a-f]{64}$/;

/** How this module refuses one kind of record. */
type Reject = (reason: string) => never;

function rejecting(path: string, kind: string): Reject {
  return (reason: string) => {
    throw new XmdArtifactRecordError(path, kind, reason);
  };
}

/** The `Fail` shape the shared member parsers report through. */
function failing(path: string, kind: string): Fail {
  return (reason: string, at: string) =>
    new XmdArtifactRecordError(path, kind, at === "$" ? reason : `${reason} at ${at}`);
}

function json(kind: string, identity: Json, value: Json): XmdArtifactContentEntry {
  return Object.freeze({
    kind,
    identity,
    encoding: "canonical-json" as const,
    content: canonicalJsonBytes(value),
  });
}

function utf8(kind: string, identity: Json, text: string): XmdArtifactContentEntry {
  return Object.freeze({
    kind,
    identity,
    encoding: "utf8" as const,
    content: encoder.encode(text),
  });
}

/**
 * Bytes the caller no longer shares with what is sealed.
 *
 * Copied rather than referenced, because a caller that keeps writing into its
 * own array after handing it over would otherwise be editing evidence whose
 * hash has already been taken.
 */
function raw(kind: string, identity: Json, bytes: Uint8Array): XmdArtifactContentEntry {
  return Object.freeze({ kind, identity, encoding: "bytes" as const, content: bytes.slice() });
}

function stopReasonToJson(reason: WorkflowStopReason): Json {
  return reason.kind === "host"
    ? { kind: "host", code: reason.code }
    : { kind: "journal", eventId: reason.eventId };
}

/** Every entry one snapshot produces, in no particular order. */
export function encodeXmdArtifactInventory(
  contents: XmdArtifactContents,
): XmdArtifactContentEntry[] {
  const entries: XmdArtifactContentEntry[] = [];

  entries.push(
    json("artifact-frontier", null, {
      sourceRunId: contents.frontier.sourceRunId,
      ...(contents.frontier.finalEventId === undefined
        ? {}
        : { finalEventId: contents.frontier.finalEventId }),
      currentWorkspaceRootId: contents.frontier.currentWorkspaceRootId,
    }),
  );

  entries.push(
    json("workflow-run", null, {
      runId: contents.run.runId,
      definition: definitionToJson(contents.run.definition),
      base: contents.run.base,
      props: contents.run.props,
      status: contents.run.status,
      ...(contents.run.stopReason === undefined
        ? {}
        : { stopReason: stopReasonToJson(contents.run.stopReason) }),
      createdAt: contents.run.createdAt,
      updatedAt: contents.run.updatedAt,
    }),
  );

  contents.executions.forEach((execution, position) => {
    entries.push(
      json("document-execution", execution.executionId, {
        position,
        executionId: execution.executionId,
        startedAt: execution.startedAt,
        ...(execution.stoppedAt === undefined ? {} : { stoppedAt: execution.stoppedAt }),
        ...(execution.stopStatus === undefined ? {} : { stopStatus: execution.stopStatus }),
        ...(execution.stopReason === undefined
          ? {}
          : { stopReason: stopReasonToJson(execution.stopReason) }),
      }),
    );
  });

  if (contents.lineage !== undefined) {
    entries.push(
      json("fork-lineage", null, {
        sourceRunId: contents.lineage.sourceRunId,
        checkpointEventId: contents.lineage.checkpointEventId,
        checkpointWorkspaceRootId: contents.lineage.checkpointWorkspaceRootId,
        createdAt: contents.lineage.createdAt,
      }),
    );
  }

  contents.journal.forEach((row, position) => {
    entries.push(
      json("journal-event", row.eventId, {
        position,
        eventId: row.eventId,
        workspaceRootId: row.workspaceRootId,
        ...(row.inherited === undefined
          ? {}
          : {
              inherited: {
                sourceRunId: row.inherited.sourceRunId,
                sourceEventId: row.inherited.sourceEventId,
              },
            }),
      }),
    );
    entries.push(utf8("journal-record", row.eventId, row.record));
  });

  for (const root of contents.roots) {
    entries.push(
      json("workspace-root", root.rootId, {
        rootId: root.rootId,
        manifestHashes: [...root.manifestHashes],
        blobHashes: [...root.blobHashes],
      }),
    );
    entries.push(utf8("workspace-root-manifest", root.rootId, root.manifest));
  }

  for (const manifest of contents.manifests) {
    const hash = toHex(manifest.hash);
    entries.push(
      json("dofs-manifest", hash, { hash, size: manifest.size, lastSeen: manifest.lastSeen }),
    );
    entries.push(raw("dofs-manifest-bytes", hash, manifest.encoded));
  }

  for (const blob of contents.blobs) {
    const hash = toHex(blob.hash);
    entries.push(json("dofs-blob", hash, { hash, size: blob.size, lastSeen: blob.lastSeen }));
    entries.push(raw("dofs-blob-bytes", hash, blob.content));
  }

  for (const repository of contents.repositories) {
    entries.push(
      json("workspace-repository", repository.name, {
        name: repository.name,
        locator: repository.locator,
        locatorFingerprint: repository.locatorFingerprint,
        requestedBase: repository.requestedBase,
        creationCommit: repository.creationCommit,
        primaryBranch: repository.primaryBranch,
        objectFormat: repository.objectFormat,
        checkoutPath: repository.checkoutPath,
      }),
    );
  }

  for (const worktree of contents.worktrees) {
    entries.push(
      json("workspace-worktree", [worktree.repositoryName, worktree.name], {
        repositoryName: worktree.repositoryName,
        name: worktree.name,
        requestedBranch: worktree.requestedBranch,
        requestedBase: worktree.requestedBase,
        creationCommit: worktree.creationCommit,
        checkoutPath: worktree.checkoutPath,
      }),
    );
  }

  for (const answer of contents.answers) {
    entries.push(
      json("suspension-answer", answer.suspensionId, {
        suspensionId: answer.suspensionId,
        requestEventId: answer.requestEventId,
        requestFingerprint: answer.requestFingerprint,
        answer: answer.answer,
        state: answer.state,
        createdAt: answer.createdAt,
        ...(answer.consumedAt === undefined ? {} : { consumedAt: answer.consumedAt }),
      }),
    );
  }

  for (const session of contents.agentSessions) {
    entries.push(
      json("agent-session", session.sessionKey, {
        sessionKey: session.sessionKey,
        provider: session.provider,
        agentCommand: session.agentCommand,
        sessionIdentity: session.sessionIdentity,
        policy: session.policy,
        assertion: { kind: session.assertion.kind, value: session.assertion.value },
        createdAt: session.createdAt,
      }),
    );
  }

  const root = contents.definition.root;
  entries.push(
    json("definition-source-root", null, {
      objectFormat: root.objectFormat,
      pinnedCommit: root.pinnedCommit,
      rootDocumentPath: root.rootDocumentPath,
      ...(root.targetPath === undefined ? {} : { targetPath: root.targetPath }),
      blobId: root.blobId,
    }),
  );
  entries.push(utf8("definition-source-root-content", null, root.content));

  for (const component of contents.definition.components) {
    entries.push(
      json("definition-source-component", component.name, {
        name: component.name,
        path: component.path,
        blobId: component.blobId,
      }),
    );
    entries.push(utf8("definition-source-component-content", component.name, component.content));
  }

  return entries;
}

/** The accepted entries, grouped so each kind can be asked for by identity. */
class Inventory {
  readonly #path: string;
  readonly #byKind = new Map<string, Map<string, XmdArtifactContentEntry>>();
  readonly #claimed = new Set<string>();

  constructor(path: string, entries: readonly XmdArtifactContentEntry[]) {
    this.#path = path;
    for (const entry of entries) {
      let group = this.#byKind.get(entry.kind);
      if (group === undefined) {
        group = new Map();
        this.#byKind.set(entry.kind, group);
      }
      const identity = canonicalJsonText(entry.identity);
      if (group.has(identity)) {
        throw new XmdArtifactInventoryError(
          this.#path,
          `it holds more than one ${entry.kind} record under one identity`,
        );
      }
      group.set(identity, entry);
    }
  }

  /** Every identity present under one kind, in canonical identity order. */
  identities(kind: string): string[] {
    return [...(this.#byKind.get(kind)?.keys() ?? [])].sort(compareUtf8);
  }

  has(kind: string, identity: Json): boolean {
    return this.#byKind.get(kind)?.has(canonicalJsonText(identity)) === true;
  }

  /** One entry, marked as accounted for. Absent is a missing declared entry. */
  take(kind: string, identity: Json): XmdArtifactContentEntry {
    const entry = this.#byKind.get(kind)?.get(canonicalJsonText(identity));
    if (entry === undefined) {
      throw new XmdArtifactInventoryError(this.#path, `it is missing a ${kind} record`);
    }
    this.#claimed.add(entryKey(kind, identity));
    return entry;
  }

  /**
   * Refuse any entry nothing declared has claimed.
   *
   * The other half of completeness. `take()` catches a record that should be
   * there and is not; this catches one that is there and should not be, which
   * is how an inventory that had grown an undeclared kind — or a second record
   * under a kind that holds exactly one — would otherwise pass unnoticed.
   */
  requireNothingLeftOver(): void {
    for (const [kind, group] of this.#byKind) {
      for (const entry of group.values()) {
        if (!this.#claimed.has(entryKey(kind, entry.identity))) {
          throw new XmdArtifactInventoryError(
            this.#path,
            `it holds a ${kind} record nothing in it declares`,
          );
        }
      }
    }
  }
}

/** The structured value a `canonical-json` entry holds. */
function structured(entry: XmdArtifactContentEntry, path: string): Json {
  const reject: Reject = rejecting(path, entry.kind);
  if (entry.encoding !== "canonical-json") {
    reject("it is not stored as canonical JSON");
  }
  let text: string;
  try {
    text = decoder.decode(entry.content);
  } catch {
    reject("it is not UTF-8");
  }
  let offered: unknown;
  try {
    offered = JSON.parse(text);
  } catch {
    // The thrown SyntaxError quotes the offending text, which is the one thing
    // a refusal about retained content must not repeat.
    reject("it is not JSON");
  }
  const value = parseJsonValue(offered, "$", failing(path, entry.kind));
  if (canonicalJsonText(value) !== text) {
    reject("it is not canonically encoded");
  }
  return value;
}

/** The text a `utf8` entry holds, exactly as it was retained. */
function textOf(entry: XmdArtifactContentEntry, path: string): string {
  const reject: Reject = rejecting(path, entry.kind);
  if (entry.encoding !== "utf8") {
    reject("it is not stored as UTF-8 text");
  }
  try {
    return decoder.decode(entry.content);
  } catch {
    reject("it is not UTF-8");
  }
}

/** The bytes a `bytes` entry holds. */
function bytesOf(entry: XmdArtifactContentEntry, path: string): Uint8Array {
  if (entry.encoding !== "bytes") {
    const reject: Reject = rejecting(path, entry.kind);
    reject("it is not stored as bytes");
  }
  return entry.content;
}

function members(value: Json, names: readonly string[], path: string, kind: string) {
  const fail = failing(path, kind);
  const parsed = parseMembers(value, "$", fail);
  requireMemberNames(parsed, names, "$", fail);
  return parsed;
}

function required(parsed: Map<string, unknown>, key: string, path: string, kind: string): string {
  const value = parsed.get(key);
  if (typeof value !== "string" || value === "") {
    throw new XmdArtifactRecordError(
      path,
      kind,
      `expected a non-empty ${key}, found ${describe(value)}`,
    );
  }
  return value;
}

function optional(
  parsed: Map<string, unknown>,
  key: string,
  path: string,
  kind: string,
): string | undefined {
  return parsed.get(key) === undefined ? undefined : required(parsed, key, path, kind);
}

/**
 * A moment, rather than any text at all.
 *
 * A round trip rather than a pattern: `Date` accepts the 31st of February and
 * quietly answers with the 3rd of March, so a shape test alone would admit a
 * day that never happened and then report a different one.
 */
function instant(parsed: Map<string, unknown>, key: string, path: string, kind: string): string {
  const value = required(parsed, key, path, kind);
  const moment = new Date(value);
  if (Number.isNaN(moment.getTime()) || moment.toISOString() !== value) {
    throw new XmdArtifactRecordError(path, kind, `expected ${key} to be an ISO 8601 instant`);
  }
  return value;
}

function optionalInstant(
  parsed: Map<string, unknown>,
  key: string,
  path: string,
  kind: string,
): string | undefined {
  return parsed.get(key) === undefined ? undefined : instant(parsed, key, path, kind);
}

/** A count, a length, a position or a version: a safe non-negative integer. */
function whole(parsed: Map<string, unknown>, key: string, path: string, kind: string): number {
  const value = parsed.get(key);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new XmdArtifactRecordError(
      path,
      kind,
      `expected ${key} to be a whole number, found ${describe(value)}`,
    );
  }
  return value;
}

function hex(value: string, path: string, kind: string, label: string): Uint8Array {
  if (!SHA256.test(value)) {
    throw new XmdArtifactRecordError(path, kind, `${label} is not a lowercase SHA-256 identity`);
  }
  return new Uint8Array(Buffer.from(value, "hex"));
}

function stopReason(
  parsed: Map<string, unknown>,
  path: string,
  kind: string,
): WorkflowStopReason | undefined {
  const value = parsed.get("stopReason");
  if (value === undefined) {
    return undefined;
  }
  return parseWorkflowStopReason(value, "$.stopReason", failing(path, kind));
}

function status(
  parsed: Map<string, unknown>,
  key: string,
  path: string,
  kind: string,
): WorkflowRunStatus {
  return parseWorkflowRunStatus(parsed.get(key), `$.${key}`, failing(path, kind));
}

function definition(parsed: Map<string, unknown>, path: string, kind: string): WorkflowDefinition {
  const value = parsed.get("definition");
  const result = parseWorkflowDefinition(value);
  if (!result.ok) {
    throw new XmdArtifactRecordError(path, kind, result.error.message);
  }
  return result.value;
}

/**
 * The records in their retained order, refusing any order with a hole in it.
 *
 * Position is carried by each record rather than implied by how the container
 * happened to return its rows, because the physical order of a generic content
 * table is not evidence about anything. A gap or a repeat means a record is
 * missing or duplicated, and a history with a hole in it is not history.
 */
function ordered<T>(
  rows: readonly { readonly position: number; readonly value: T }[],
  path: string,
  kind: string,
): readonly T[] {
  const sorted = [...rows].sort((left, right) => left.position - right.position);
  for (const [index, row] of sorted.entries()) {
    if (row.position !== index) {
      throw new XmdArtifactInventoryError(
        path,
        `its ${kind} records do not occupy one contiguous retained order`,
      );
    }
  }
  return Object.freeze(sorted.map((row) => row.value));
}

/**
 * The snapshot one accepted inventory describes.
 *
 * Total: every declared record is claimed and parsed, and anything left over
 * refuses the file. A reader that stopped once it had what a caller asked for
 * would be reporting a status whose journal it had never looked at.
 */
export function decodeXmdArtifactInventory(
  entries: readonly XmdArtifactContentEntry[],
  path: string,
): XmdArtifactContents {
  const inventory = new Inventory(path, entries);

  const frontier = decodeFrontier(inventory, path);
  const run = decodeRun(inventory, path);
  const executions = decodeExecutions(inventory, path);
  const lineage = decodeLineage(inventory, path);
  const journal = decodeJournal(inventory, path);
  const roots = decodeRoots(inventory, path);
  const manifests = decodeManifests(inventory, path);
  const blobs = decodeBlobs(inventory, path);
  const repositories = decodeRepositories(inventory, path);
  const worktrees = decodeWorktrees(inventory, path);
  const answers = decodeAnswers(inventory, path);
  const agentSessions = decodeAgentSessions(inventory, path);
  const closure = decodeDefinitionClosure(inventory, path);

  inventory.requireNothingLeftOver();

  return Object.freeze({
    frontier,
    run,
    executions,
    ...(lineage === undefined ? {} : { lineage }),
    journal,
    roots,
    manifests,
    blobs,
    repositories,
    worktrees,
    answers,
    agentSessions,
    definition: closure,
  });
}

function decodeFrontier(inventory: Inventory, path: string): XmdArtifactFrontier {
  const kind = "artifact-frontier";
  const parsed = members(
    structured(inventory.take(kind, null), path),
    ["sourceRunId", "finalEventId", "currentWorkspaceRootId"],
    path,
    kind,
  );
  const finalEventId = optional(parsed, "finalEventId", path, kind);
  return Object.freeze({
    sourceRunId: parseRunId(parsed.get("sourceRunId"), "$.sourceRunId", failing(path, kind)),
    ...(finalEventId === undefined ? {} : { finalEventId }),
    currentWorkspaceRootId: required(parsed, "currentWorkspaceRootId", path, kind),
  });
}

function decodeRun(inventory: Inventory, path: string): WorkflowRunRecord {
  const kind = "workflow-run";
  const parsed = members(
    structured(inventory.take(kind, null), path),
    ["runId", "definition", "base", "props", "status", "stopReason", "createdAt", "updatedAt"],
    path,
    kind,
  );
  const reason = stopReason(parsed, path, kind);
  const record: WorkflowRunRecord = {
    runId: parseRunId(parsed.get("runId"), "$.runId", failing(path, kind)),
    definition: definition(parsed, path, kind),
    base: required(parsed, "base", path, kind),
    props: parseJsonObject(parsed.get("props"), "$.props", failing(path, kind)),
    status: status(parsed, "status", path, kind),
    createdAt: instant(parsed, "createdAt", path, kind),
    updatedAt: instant(parsed, "updatedAt", path, kind),
  };
  return Object.freeze(reason === undefined ? record : { ...record, stopReason: reason });
}

function decodeExecutions(inventory: Inventory, path: string): readonly DocumentExecutionRecord[] {
  const kind = "document-execution";
  const rows = inventory.identities(kind).map((identity) => {
    const parsed = members(
      structured(inventory.take(kind, JSON.parse(identity) as Json), path),
      ["position", "executionId", "startedAt", "stoppedAt", "stopStatus", "stopReason"],
      path,
      kind,
    );
    const executionId = required(parsed, "executionId", path, kind);
    if (canonicalJsonText(executionId) !== identity) {
      throw new XmdArtifactInventoryError(
        path,
        "a document-execution record is stored under an identity it does not carry",
      );
    }
    const stoppedAt = optionalInstant(parsed, "stoppedAt", path, kind);
    const reason = stopReason(parsed, path, kind);
    const started: DocumentExecutionRecord = {
      executionId,
      startedAt: instant(parsed, "startedAt", path, kind),
    };
    if (stoppedAt === undefined) {
      if (parsed.get("stopStatus") !== undefined || reason !== undefined) {
        throw new XmdArtifactRecordError(
          path,
          kind,
          "an unfinished execution carries how it finished",
        );
      }
      return { position: whole(parsed, "position", path, kind), value: Object.freeze(started) };
    }
    const stopped: DocumentExecutionRecord = {
      ...started,
      stoppedAt,
      stopStatus: status(parsed, "stopStatus", path, kind),
    };
    return {
      position: whole(parsed, "position", path, kind),
      value: Object.freeze(reason === undefined ? stopped : { ...stopped, stopReason: reason }),
    };
  });
  return ordered(rows, path, kind);
}

function decodeLineage(inventory: Inventory, path: string): XmdArtifactForkLineage | undefined {
  const kind = "fork-lineage";
  if (!inventory.has(kind, null)) {
    return undefined;
  }
  const parsed = members(
    structured(inventory.take(kind, null), path),
    ["sourceRunId", "checkpointEventId", "checkpointWorkspaceRootId", "createdAt"],
    path,
    kind,
  );
  return Object.freeze({
    sourceRunId: required(parsed, "sourceRunId", path, kind),
    checkpointEventId: required(parsed, "checkpointEventId", path, kind),
    checkpointWorkspaceRootId: required(parsed, "checkpointWorkspaceRootId", path, kind),
    createdAt: instant(parsed, "createdAt", path, kind),
  });
}

function decodeJournal(inventory: Inventory, path: string): readonly XmdArtifactJournalRow[] {
  const kind = "journal-event";
  const rows = inventory.identities(kind).map((identity) => {
    const eventIdentity = JSON.parse(identity) as Json;
    const parsed = members(
      structured(inventory.take(kind, eventIdentity), path),
      ["position", "eventId", "workspaceRootId", "inherited"],
      path,
      kind,
    );
    const eventId = required(parsed, "eventId", path, kind);
    if (canonicalJsonText(eventId) !== identity) {
      throw new XmdArtifactInventoryError(
        path,
        "a journal record is stored under an identity it does not carry",
      );
    }
    const record = textOf(inventory.take("journal-record", eventIdentity), path);
    const event = parseDurableEvent(record);
    if (!event.ok) {
      throw new XmdArtifactRecordError(path, "journal-record", "it is not a durable event");
    }
    try {
      readEventSource(event.value);
    } catch {
      // The live parser names the retained field and its shape; what it read is
      // filtered history and stays out of the sentence that reaches a terminal.
      throw new XmdArtifactRecordError(
        path,
        "journal-record",
        "the authored source position it carries does not describe one",
      );
    }
    const row: XmdArtifactJournalRow = {
      eventId,
      record,
      workspaceRootId: required(parsed, "workspaceRootId", path, kind),
    };
    const inherited = decodeProvenance(parsed.get("inherited"), path, kind);
    return {
      position: whole(parsed, "position", path, kind),
      value: Object.freeze(inherited === undefined ? row : { ...row, inherited }),
    };
  });
  return ordered(rows, path, kind);
}

function decodeProvenance(
  value: unknown,
  path: string,
  kind: string,
): InheritedEventProvenance | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = members(
    parseJsonValue(value, "$.inherited", failing(path, kind)),
    ["sourceRunId", "sourceEventId"],
    path,
    kind,
  );
  return Object.freeze({
    sourceRunId: required(parsed, "sourceRunId", path, kind),
    sourceEventId: required(parsed, "sourceEventId", path, kind),
  });
}

function decodeRoots(inventory: Inventory, path: string): readonly StoredWorkspaceRoot[] {
  const kind = "workspace-root";
  return Object.freeze(
    inventory.identities(kind).map((identity) => {
      const rootIdentity = JSON.parse(identity) as Json;
      const parsed = members(
        structured(inventory.take(kind, rootIdentity), path),
        ["rootId", "manifestHashes", "blobHashes"],
        path,
        kind,
      );
      const rootId = required(parsed, "rootId", path, kind);
      if (canonicalJsonText(rootId) !== identity) {
        throw new XmdArtifactInventoryError(
          path,
          "a Workspace root is stored under an identity it does not carry",
        );
      }
      const manifest = textOf(inventory.take("workspace-root-manifest", rootIdentity), path);
      // Parsed with this module's own refusal: the live default names a run
      // database and tells an operator to restore it from a backup, which is
      // advice about a file an artifact is not.
      parseWorkspaceManifest(manifest, path, rejecting(path, "workspace-root-manifest"));
      return Object.freeze({
        rootId,
        manifest,
        manifestHashes: hashes(parsed, "manifestHashes", path, kind),
        blobHashes: hashes(parsed, "blobHashes", path, kind),
      });
    }),
  );
}

function hashes(
  parsed: Map<string, unknown>,
  key: string,
  path: string,
  kind: string,
): readonly string[] {
  const value = parsed.get(key);
  if (!Array.isArray(value)) {
    throw new XmdArtifactRecordError(
      path,
      kind,
      `expected ${key} to be an array, found ${describe(value)}`,
    );
  }
  const list: string[] = [];
  let previous: string | undefined;
  for (const item of value) {
    if (typeof item !== "string" || !SHA256.test(item)) {
      throw new XmdArtifactRecordError(path, kind, `${key} names something that is not a hash`);
    }
    if (previous !== undefined && compareUtf8(previous, item) >= 0) {
      throw new XmdArtifactRecordError(
        path,
        kind,
        `${key} is duplicated or out of canonical order`,
      );
    }
    previous = item;
    list.push(item);
  }
  return Object.freeze(list);
}

function decodeManifests(inventory: Inventory, path: string): readonly RetainedManifest[] {
  const kind = "dofs-manifest";
  return Object.freeze(
    inventory.identities(kind).map((identity) => {
      const hashIdentity = JSON.parse(identity) as Json;
      const parsed = members(
        structured(inventory.take(kind, hashIdentity), path),
        ["hash", "size", "lastSeen"],
        path,
        kind,
      );
      const hash = required(parsed, "hash", path, kind);
      if (canonicalJsonText(hash) !== identity) {
        throw new XmdArtifactInventoryError(
          path,
          "a DOFS manifest is stored under an identity it does not carry",
        );
      }
      return Object.freeze({
        hash: hex(hash, path, kind, "a DOFS manifest identity"),
        size: whole(parsed, "size", path, kind),
        encoded: bytesOf(inventory.take("dofs-manifest-bytes", hashIdentity), path),
        lastSeen: whole(parsed, "lastSeen", path, kind),
      });
    }),
  );
}

function decodeBlobs(inventory: Inventory, path: string): readonly RetainedBlob[] {
  const kind = "dofs-blob";
  return Object.freeze(
    inventory.identities(kind).map((identity) => {
      const hashIdentity = JSON.parse(identity) as Json;
      const parsed = members(
        structured(inventory.take(kind, hashIdentity), path),
        ["hash", "size", "lastSeen"],
        path,
        kind,
      );
      const hash = required(parsed, "hash", path, kind);
      if (canonicalJsonText(hash) !== identity) {
        throw new XmdArtifactInventoryError(
          path,
          "a DOFS blob is stored under an identity it does not carry",
        );
      }
      return Object.freeze({
        hash: hex(hash, path, kind, "a DOFS blob identity"),
        size: whole(parsed, "size", path, kind),
        lastSeen: whole(parsed, "lastSeen", path, kind),
        content: bytesOf(inventory.take("dofs-blob-bytes", hashIdentity), path),
      });
    }),
  );
}

function decodeRepositories(inventory: Inventory, path: string): readonly RetainedRepository[] {
  const kind = "workspace-repository";
  return Object.freeze(
    inventory.identities(kind).map((identity) => {
      const parsed = members(
        structured(inventory.take(kind, JSON.parse(identity) as Json), path),
        [
          "name",
          "locator",
          "locatorFingerprint",
          "requestedBase",
          "creationCommit",
          "primaryBranch",
          "objectFormat",
          "checkoutPath",
        ],
        path,
        kind,
      );
      const name = required(parsed, "name", path, kind);
      if (canonicalJsonText(name) !== identity) {
        throw new XmdArtifactInventoryError(
          path,
          "a Repository record is stored under an identity it does not carry",
        );
      }
      const objectFormat = required(parsed, "objectFormat", path, kind);
      if (objectFormat !== "sha1" && objectFormat !== "sha256") {
        throw new XmdArtifactRecordError(path, kind, "its object format names no Git format");
      }
      return Object.freeze({
        name,
        locator: required(parsed, "locator", path, kind),
        locatorFingerprint: fingerprint(parsed, "locatorFingerprint", path, kind),
        requestedBase:
          parsed.get("requestedBase") === null
            ? null
            : required(parsed, "requestedBase", path, kind),
        creationCommit: required(parsed, "creationCommit", path, kind),
        primaryBranch: required(parsed, "primaryBranch", path, kind),
        objectFormat,
        checkoutPath: checkoutPath(parsed, path, kind),
      });
    }),
  );
}

function decodeWorktrees(inventory: Inventory, path: string): readonly RetainedWorktree[] {
  const kind = "workspace-worktree";
  return Object.freeze(
    inventory.identities(kind).map((identity) => {
      const parsed = members(
        structured(inventory.take(kind, JSON.parse(identity) as Json), path),
        [
          "repositoryName",
          "name",
          "requestedBranch",
          "requestedBase",
          "creationCommit",
          "checkoutPath",
        ],
        path,
        kind,
      );
      const repositoryName = required(parsed, "repositoryName", path, kind);
      const name = required(parsed, "name", path, kind);
      if (canonicalJsonText([repositoryName, name]) !== identity) {
        throw new XmdArtifactInventoryError(
          path,
          "a Worktree record is stored under an identity it does not carry",
        );
      }
      return Object.freeze({
        repositoryName,
        name,
        requestedBranch: required(parsed, "requestedBranch", path, kind),
        requestedBase:
          parsed.get("requestedBase") === null
            ? null
            : required(parsed, "requestedBase", path, kind),
        creationCommit: required(parsed, "creationCommit", path, kind),
        checkoutPath: checkoutPath(parsed, path, kind),
      });
    }),
  );
}

function fingerprint(
  parsed: Map<string, unknown>,
  key: string,
  path: string,
  kind: string,
): string {
  const value = required(parsed, key, path, kind);
  if (!SHA256.test(value)) {
    throw new XmdArtifactRecordError(path, kind, `its ${key} is not a lowercase SHA-256 identity`);
  }
  return value;
}

/**
 * A checkout's logical Workspace path, which is not a host path.
 *
 * Absolute inside the run's own Workspace, exactly as the live tables require.
 * Where that Workspace was materialized on the exporting machine is host
 * arrangement and never crosses the artifact boundary.
 */
function checkoutPath(parsed: Map<string, unknown>, path: string, kind: string): string {
  const value = required(parsed, "checkoutPath", path, kind);
  if (!value.startsWith("/")) {
    throw new XmdArtifactRecordError(
      path,
      kind,
      "its checkout path is not a logical Workspace path",
    );
  }
  return value;
}

function decodeAnswers(inventory: Inventory, path: string): readonly RetainedAnswer[] {
  const kind = "suspension-answer";
  return Object.freeze(
    inventory.identities(kind).map((identity) => {
      const parsed = members(
        structured(inventory.take(kind, JSON.parse(identity) as Json), path),
        [
          "suspensionId",
          "requestEventId",
          "requestFingerprint",
          "answer",
          "state",
          "createdAt",
          "consumedAt",
        ],
        path,
        kind,
      );
      const suspensionId = required(parsed, "suspensionId", path, kind);
      if (canonicalJsonText(suspensionId) !== identity) {
        throw new XmdArtifactInventoryError(
          path,
          "a suspension answer is stored under an identity it does not carry",
        );
      }
      const state = required(parsed, "state", path, kind);
      if (state !== "pending" && state !== "consumed") {
        throw new XmdArtifactRecordError(path, kind, "its state is neither pending nor consumed");
      }
      const consumedAt = optionalInstant(parsed, "consumedAt", path, kind);
      if ((state === "consumed") !== (consumedAt !== undefined)) {
        throw new XmdArtifactRecordError(
          path,
          kind,
          "its state and the moment it was consumed disagree",
        );
      }
      return Object.freeze({
        suspensionId,
        requestEventId: required(parsed, "requestEventId", path, kind),
        requestFingerprint: fingerprint(parsed, "requestFingerprint", path, kind),
        answer: parseJsonValue(parsed.get("answer"), "$.answer", failing(path, kind)),
        state: state as RetainedAnswerState,
        createdAt: instant(parsed, "createdAt", path, kind),
        consumedAt,
      });
    }),
  );
}

function decodeAgentSessions(inventory: Inventory, path: string): readonly AgentSessionRecord[] {
  const kind = "agent-session";
  return Object.freeze(
    inventory.identities(kind).map((identity) => {
      const parsed = members(
        structured(inventory.take(kind, JSON.parse(identity) as Json), path),
        [
          "sessionKey",
          "provider",
          "agentCommand",
          "sessionIdentity",
          "policy",
          "assertion",
          "createdAt",
        ],
        path,
        kind,
      );
      const sessionKey = required(parsed, "sessionKey", path, kind);
      if (canonicalJsonText(sessionKey) !== identity) {
        throw new XmdArtifactInventoryError(
          path,
          "an Agent session mapping is stored under an identity it does not carry",
        );
      }
      const assertion = members(
        parseJsonValue(parsed.get("assertion"), "$.assertion", failing(path, kind)),
        ["kind", "value"],
        path,
        kind,
      );
      return Object.freeze({
        sessionKey,
        provider: required(parsed, "provider", path, kind),
        agentCommand: required(parsed, "agentCommand", path, kind),
        sessionIdentity: required(parsed, "sessionIdentity", path, kind),
        policy: required(parsed, "policy", path, kind),
        assertion: Object.freeze({
          kind: required(assertion, "kind", path, kind),
          value: required(assertion, "value", path, kind),
        }),
        createdAt: instant(parsed, "createdAt", path, kind),
      });
    }),
  );
}

function decodeDefinitionClosure(inventory: Inventory, path: string): XmdArtifactDefinitionClosure {
  const kind = "definition-source-root";
  const parsed = members(
    structured(inventory.take(kind, null), path),
    ["objectFormat", "pinnedCommit", "rootDocumentPath", "targetPath", "blobId"],
    path,
    kind,
  );
  const objectFormat = required(parsed, "objectFormat", path, kind);
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw new XmdArtifactRecordError(path, kind, "its object format names no Git format");
  }
  const targetPath = optional(parsed, "targetPath", path, kind);
  const root: XmdArtifactDefinitionRoot = Object.freeze({
    objectFormat,
    pinnedCommit: required(parsed, "pinnedCommit", path, kind),
    rootDocumentPath: required(parsed, "rootDocumentPath", path, kind),
    ...(targetPath === undefined ? {} : { targetPath }),
    blobId: required(parsed, "blobId", path, kind),
    content: textOf(inventory.take("definition-source-root-content", null), path),
  });

  const componentKind = "definition-source-component";
  const components: XmdArtifactDefinitionComponent[] = inventory
    .identities(componentKind)
    .map((identity) => {
      const nameIdentity = JSON.parse(identity) as Json;
      const entry = members(
        structured(inventory.take(componentKind, nameIdentity), path),
        ["name", "path", "blobId"],
        path,
        componentKind,
      );
      const name = required(entry, "name", path, componentKind);
      if (canonicalJsonText(name) !== identity) {
        throw new XmdArtifactInventoryError(
          path,
          "a definition component is stored under an identity it does not carry",
        );
      }
      return Object.freeze({
        name,
        path: required(entry, "path", path, componentKind),
        blobId: required(entry, "blobId", path, componentKind),
        content: textOf(inventory.take("definition-source-component-content", nameIdentity), path),
      });
    });

  return Object.freeze({ root, components: Object.freeze(components) });
}

function inventoryFailure(path: string): Reject {
  return (reason: string) => {
    throw new XmdArtifactInventoryError(path, reason);
  };
}

/**
 * Whether these records describe one snapshot a live workflow contract accepts.
 *
 * Container hashes prove that nobody edited the bytes. They say nothing about
 * whether the lifecycle points at an event the journal holds, whether a root
 * names content the artifact carries, or whether the embedded Markdown belongs
 * to the commit the definition pins — so all of that is asked here, and it is
 * asked before any of it is handed to a caller.
 */
export function verifyXmdArtifactSemantics(contents: XmdArtifactContents, path: string): void {
  const reject: Reject = inventoryFailure(path);

  const eventIds = new Set(contents.journal.map((row) => row.eventId));
  if (eventIds.size !== contents.journal.length) {
    reject("two of its journal rows carry one event identity");
  }

  if (contents.frontier.sourceRunId !== contents.run.runId) {
    reject("its frontier names a run other than the one it retains");
  }

  const last = contents.journal.at(-1);
  if (contents.frontier.finalEventId !== last?.eventId) {
    reject("its frontier does not name the last committed event it holds");
  }

  verifyLifecycle(contents, eventIds, reject);
  const manifests = verifyContentStore(contents, reject);
  verifyRoots(contents, manifests, path, reject);
  verifyCheckouts(contents, reject);
  verifySuspensions(contents, eventIds, reject);
  verifyAgentSessions(contents, reject);
  verifyDefinitionClosure(contents, reject);
}

function verifyLifecycle(
  contents: XmdArtifactContents,
  eventIds: ReadonlySet<string>,
  reject: Reject,
): void {
  const reasons: (WorkflowStopReason | undefined)[] = [
    contents.run.stopReason,
    ...contents.executions.map((execution) => execution.stopReason),
  ];
  for (const reason of reasons) {
    if (reason?.kind === "journal" && !eventIds.has(reason.eventId)) {
      reject("a stop reason names an event it does not hold");
    }
  }

  const executionIds = new Set(contents.executions.map((execution) => execution.executionId));
  if (executionIds.size !== contents.executions.length) {
    reject("two of its document executions carry one identity");
  }

  const rootIds = new Set(contents.roots.map((root) => root.rootId));
  if (rootIds.size !== contents.roots.length) {
    reject("two of its Workspace roots carry one identity");
  }
  if (!rootIds.has(contents.frontier.currentWorkspaceRootId)) {
    reject("its current Workspace root is not one it retains");
  }
  for (const row of contents.journal) {
    if (!rootIds.has(row.workspaceRootId)) {
      reject("a journal row names a Workspace root it does not retain");
    }
  }
  if (contents.lineage !== undefined && !rootIds.has(contents.lineage.checkpointWorkspaceRootId)) {
    reject("its fork lineage names a Workspace root it does not retain");
  }
}

/**
 * Every retained byte, held to the identity it is stored under.
 *
 * Sizes and hashes are recomputed rather than believed: the manifest already
 * proved the bytes are the ones that were sealed, and this proves the bytes are
 * the ones the DOFS records claim to be about.
 */
function verifyContentStore(
  contents: XmdArtifactContents,
  reject: Reject,
): ReadonlyMap<string, DofsManifest> {
  const blobs = new Map<string, number>();
  for (const blob of contents.blobs) {
    const hash = toHex(blob.hash);
    if (blobs.has(hash)) {
      reject("it holds one DOFS blob twice");
    }
    if (blob.content.byteLength !== blob.size || toHex(sha256(blob.content)) !== hash) {
      reject("a DOFS blob's declared size or identity does not match its bytes");
    }
    blobs.set(hash, blob.size);
  }

  const manifests = new Map<string, DofsManifest>();
  for (const manifest of contents.manifests) {
    const hash = toHex(manifest.hash);
    if (manifests.has(hash)) {
      reject("it holds one DOFS manifest twice");
    }
    if (toHex(sha256(manifest.encoded)) !== hash) {
      reject("a DOFS manifest's identity does not match its bytes");
    }
    const decoded = decodeDofsManifest(manifest.encoded, reject);
    if (decoded.size !== manifest.size) {
      reject("a DOFS manifest's declared size does not equal its chunks");
    }
    for (const chunk of decoded.chunks) {
      if (blobs.get(chunk.hash) !== chunk.size) {
        reject("a DOFS manifest names a blob this artifact does not hold at that size");
      }
    }
    manifests.set(hash, decoded);
  }
  return manifests;
}

/**
 * Every root, held to its own bytes and to the content it declares.
 *
 * The root identity is re-derived from the manifest text, and the manifest's
 * own file entries are what decide which DOFS manifests and blobs the root
 * references — so a root that declared a shorter reference set, or that named
 * content the artifact does not carry, is refused rather than returned as a
 * Workspace nothing could restore.
 */
function verifyRoots(
  contents: XmdArtifactContents,
  manifests: ReadonlyMap<string, DofsManifest>,
  path: string,
  reject: Reject,
): void {
  const referencedManifests = new Set<string>();
  const referencedBlobs = new Set<string>();

  for (const root of contents.roots) {
    const parsed: WorkspaceRootManifest = parseWorkspaceManifest(root.manifest, path, reject);
    if (workspaceRoot(root.manifest, [], []).rootId !== root.rootId) {
      reject("a Workspace root identity does not match its manifest bytes");
    }

    const declared = new Map<string, DofsManifest>();
    for (const entry of parsed.entries) {
      if (entry.kind !== "file") {
        continue;
      }
      const manifest = manifests.get(entry.manifest);
      if (manifest === undefined) {
        reject("a Workspace root names a DOFS manifest this artifact does not hold");
      }
      if (entry.size !== manifest.size) {
        reject("a retained file size differs from its DOFS manifest");
      }
      declared.set(entry.manifest, manifest);
    }

    const blobHashes = new Set<string>();
    for (const manifest of declared.values()) {
      for (const chunk of manifest.chunks) {
        blobHashes.add(chunk.hash);
      }
    }

    if (
      !sameStrings(root.manifestHashes, [...declared.keys()].sort(compareUtf8)) ||
      !sameStrings(root.blobHashes, [...blobHashes].sort(compareUtf8))
    ) {
      reject("a Workspace root's declared content references are not the ones it needs");
    }
    for (const hash of declared.keys()) {
      referencedManifests.add(hash);
    }
    for (const hash of blobHashes) {
      referencedBlobs.add(hash);
    }
  }

  if (referencedManifests.size !== contents.manifests.length) {
    reject("it holds DOFS manifests no retained Workspace root needs");
  }
  if (referencedBlobs.size !== contents.blobs.length) {
    reject("it holds DOFS blobs no retained Workspace root needs");
  }
}

function verifyCheckouts(contents: XmdArtifactContents, reject: Reject): void {
  const repositories = new Set<string>();
  const repositoryPaths = new Set<string>();
  for (const repository of contents.repositories) {
    if (repositories.has(repository.name)) {
      reject("it holds one Repository record twice");
    }
    if (repositoryPaths.has(repository.checkoutPath)) {
      reject("two of its Repository records claim one checkout");
    }
    repositories.add(repository.name);
    repositoryPaths.add(repository.checkoutPath);
  }

  const worktreePaths = new Set<string>();
  for (const worktree of contents.worktrees) {
    if (!repositories.has(worktree.repositoryName)) {
      reject("a Worktree record names a Repository this artifact does not hold");
    }
    if (worktreePaths.has(worktree.checkoutPath)) {
      reject("two of its Worktree records claim one checkout");
    }
    worktreePaths.add(worktree.checkoutPath);
  }
}

function verifySuspensions(
  contents: XmdArtifactContents,
  eventIds: ReadonlySet<string>,
  reject: Reject,
): void {
  const suspensions = new Set<string>();
  for (const answer of contents.answers) {
    if (suspensions.has(answer.suspensionId)) {
      reject("it holds one suspension answer twice");
    }
    suspensions.add(answer.suspensionId);
    if (!eventIds.has(answer.requestEventId)) {
      reject("a suspension answer names a request event this artifact does not hold");
    }
  }
}

/**
 * Every mapping, held to the key its own identity derives.
 *
 * The key is a function of the engine-derived Session expansion identity, so a
 * row stored under a different one is a mapping this artifact could hand a fork
 * to continue a conversation nobody in it ever had.
 */
function verifyAgentSessions(contents: XmdArtifactContents, reject: Reject): void {
  const keys = new Set<string>();
  for (const session of contents.agentSessions) {
    if (keys.has(session.sessionKey)) {
      reject("it holds one Agent session mapping twice");
    }
    keys.add(session.sessionKey);
    if (agentSessionKey(session) !== session.sessionKey) {
      reject("an Agent session mapping is retained under a key its identity does not derive");
    }
  }
}

/**
 * The closure, held to the definition the run retains and to its own bytes.
 *
 * Two separate claims. The descriptor members must be the ones the workflow
 * definition already pins, or the embedded Markdown belongs to some other
 * commit; and each blob identity must be the Git object id of the bytes stored
 * beside it, or the closure is not the source that definition names.
 */
function verifyDefinitionClosure(contents: XmdArtifactContents, reject: Reject): void {
  const definition = contents.run.definition;
  const root = contents.definition.root;
  if (
    root.objectFormat !== definition.objectFormat ||
    root.pinnedCommit !== definition.objectId ||
    root.rootDocumentPath !== definition.rootDocumentPath ||
    root.targetPath !== definition.targetPath
  ) {
    reject("its definition source closure does not describe the definition the run retains");
  }
  if (gitBlobId(root.content, root.objectFormat) !== root.blobId) {
    reject("the root document bytes do not hash to the identity the closure declares");
  }

  const declared = definitionComponents(definition);
  const carried = contents.definition.components;
  if (declared.length !== carried.length) {
    reject("its definition source closure does not carry every declared component");
  }
  const byName = new Map(carried.map((component) => [component.name, component]));
  for (const component of declared) {
    const source = byName.get(component.name);
    if (source === undefined || source.path !== component.path) {
      reject("its definition source closure does not carry every declared component");
    }
    if (source.blobId !== component.sourceHash) {
      reject("a carried component names an object other than the one the definition declares");
    }
    if (gitBlobId(source.content, root.objectFormat) !== source.blobId) {
      reject("a component's bytes do not hash to the identity the closure declares");
    }
  }
}

/**
 * The Git object id of some Markdown, under the definition's object format.
 *
 * A blob's identity is the hash of `blob <length>`, one NUL, then the content —
 * the header is assembled from its own bytes rather than written as a literal,
 * because a NUL inside a source file makes that file binary to every tool that
 * reads diffs.
 */
function gitBlobId(content: string, format: "sha1" | "sha256"): string {
  const bytes = encoder.encode(content);
  return createHash(format)
    .update(encoder.encode(`blob ${bytes.byteLength}`))
    .update(new Uint8Array([0]))
    .update(bytes)
    .digest("hex");
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
