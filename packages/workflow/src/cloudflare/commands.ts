import {
  type DocumentExecutionCompletion,
  parseDocumentExecutionCompletion,
} from "../storage/record.ts";
import {
  type DurableEvent,
  parseDurableEvent,
  serializeDurableEvent,
} from "@executablemd/durable-streams";
import { SHA256 } from "../workspace/root-manifest.ts";
import { admitLocator, locatorFingerprintOf } from "../composition/locator.ts";
import {
  parseRepositoryRecord,
  parseWorktreeRecord,
  type RepositoryRecord,
  type WorktreeRecord,
} from "../composition/records.ts";
import { type AgentSessionRecord, parseAgentSessionRecord } from "../storage/agent-session.ts";
import { parseCreateRequest } from "../storage/create-request.ts";
import type { CreateWorkflowRunRequest } from "../storage/api.ts";
import { parseJsonValue } from "../storage/members.ts";
import { canonicalJson } from "../storage/record.ts";

/** The most characters a public run id may carry. */
const MAX_RUN_ID = 128;
import { MAX_MESSAGE_BYTES } from "../remote/client.ts";

export { MAX_MESSAGE_BYTES };

export const MAX_CONTENT_BYTES = 1024 * 1024;
export const MAX_STAGED_BYTES = 2 * 1024 * 1024;
export const MAX_COMMANDS = 256;
export const MAX_LEDGER_BYTES = 2 * 1024 * 1024;
export const JOURNAL_PAGE_ENTRIES = 128;
export const JOURNAL_PAGE_BYTES = 512 * 1024;
/** The most document-execution rows one private page carries. */
export const EXECUTION_PAGE_ENTRIES = 128;
/** The most serialized bytes of retained execution rows one page carries. */
export const EXECUTION_PAGE_BYTES = 512 * 1024;

/**
 * How both ends measure one execution page.
 *
 * One function rather than two similar sums: the owner decides what fits and
 * the runner checks it, and if they measured different things an honest page
 * near the bound would be sent by one and refused by the other. What is
 * measured is the exact `rows` member as it crosses, wrappers and punctuation
 * included, because that is what the bound is about.
 */
export function executionPageBytes(rows: readonly unknown[]): number {
  return new TextEncoder().encode(JSON.stringify(rows)).length;
}
/** The most content identities one proposal may name. */
export const MAX_PROPOSED_PIECES = 8192;
/** The most retained mapping changes one proposal may carry. */
export const MAX_MAPPINGS = 256;
/** The longest canonical root manifest this owner reads. */
export const MAX_ROOT_MANIFEST_BYTES = MAX_CONTENT_BYTES;

export type CommandName =
  | "frontier"
  | "journal"
  | "root"
  | "content"
  | "stage"
  | "commit"
  | "retrieval"
  | "executions"
  | "mappings"
  | "open"
  | "begin"
  | "cancel"
  | "settle"
  | "fork-stage"
  | "fork"
  | "fork-continue";

export type CommandRefusal =
  | "not-an-object"
  | "unknown-command"
  | "unknown-member"
  | "malformed-member"
  | "too-large"
  | "duplicate-conflict"
  | "capacity"
  | "unavailable"
  // The frontier moved under the proposal. Not malformed and not a conflict of
  // identity: the request was true when it was built and is not true now.
  | "stale-root"
  | "stale-journal"
  // A retained mapping already exists and describes something else. Creation
  // identity is immutable, so this is refused rather than rewritten.
  | "mapping-conflict"
  /** No run is stored here at all. A lookup found nothing, and made nothing. */
  | "absent"
  /**
   * A run is stored here, and it is not the run this request addresses.
   *
   * A retained record that parses and names another run. Distinct from damage:
   * the storage is intact and this is simply not its run, and a caller that
   * conflated them would go looking for a backup.
   */
  | "wrong-run"
  /** Retained journal history this owner cannot read. */
  | "corrupt-journal"
  /** The selected prefix is not one a fork could inherit. */
  | "not-forkable"
  /**
   * This acquisition did not begin the execution it is asking about.
   *
   * The run is intact and the execution may well exist; it belongs to a
   * different acquisition, and a live executor does not get to finish an
   * earlier executor's work by naming its id.
   */
  | "wrong-execution"
  /**
   * A fork was asked to commit a transfer this connection never offered.
   *
   * Distinct from a malformed request: the request is well formed, the
   * destination holds nothing, and the parts it names are not here — so the
   * caller's next move is to copy the source again rather than to give up.
   */
  | "needs-transfer";

export class CommandError extends Error {
  override name = "CommandError";

  constructor(readonly refusal: CommandRefusal) {
    super(`this owner refused a runner command (${refusal})`);
  }
}

export interface CommandEnvelope {
  readonly id: string;
  readonly command: CommandName;
}

export interface FrontierCommand extends CommandEnvelope {
  readonly command: "frontier";
}

export interface JournalCommand extends CommandEnvelope {
  readonly command: "journal";
  readonly anchorEventId: string | null;
  readonly afterEventId: string | null;
}

export interface RootCommand extends CommandEnvelope {
  readonly command: "root";
  readonly workspaceRootId: string;
}

export type ContentKind = "manifest" | "blob";

export interface ContentCommand extends CommandEnvelope {
  readonly command: "content";
  readonly workspaceRootId: string;
  readonly kind: ContentKind;
  readonly digest: string;
  readonly sourceManifest: string | null;
}

export interface StageCommand extends CommandEnvelope {
  readonly command: "stage";
  readonly kind: ContentKind;
  readonly digest: string;
  readonly bytes: string;
}

/**
 * One closed proposal, and everything the owner needs to decide it.
 *
 * The earlier shape carried a proposed root identity and nothing that could
 * justify it — an identity with no manifest and no content closure is a name,
 * not a proposal, and an owner adopting one would be taking the runner's word
 * for what a root contains. This carries the whole thing: what the runner
 * started from, what it proposes, the canonical manifest that identity is the
 * digest of, the exact content that manifest closes over, the retained mappings
 * the same operation produced, and the filtered events to append.
 *
 * `publication` is absent for a transaction that only appended to the journal.
 * That is a real case rather than a degenerate one, and inventing a Workspace
 * change to fill it would publish a root nothing asked for.
 */
export interface CommitCommand extends CommandEnvelope {
  readonly command: "commit";
  readonly expectedWorkspaceRootId: string;
  readonly expectedJournalEventId: string | null;
  readonly publication: ProposedPublication | null;
  readonly mappings: readonly ProposedMapping[];
  /** Exactly what `serializeDurableEvent` produced, terminating newline included. */
  readonly events: readonly string[];
}

/** The Workspace half of a proposal, when there is one. */
export interface ProposedPublication {
  readonly proposedWorkspaceRootId: string;
  readonly proposedManifest: string;
  readonly content: readonly ProposedPiece[];
}

/** One content identity the proposed root closes over. */
export interface ProposedPiece {
  readonly kind: ContentKind;
  readonly digest: string;
  readonly size: number;
}

/** One retained mapping the proposal carries, already parsed. */
export type ProposedMapping =
  | { readonly kind: "repository"; readonly record: RepositoryRecord; readonly locator: string }
  | { readonly kind: "worktree"; readonly record: WorktreeRecord }
  | { readonly kind: "agent-session"; readonly record: AgentSessionRecord };

/**
 * Replace or clear where the definition can be fetched from.
 *
 * Its own mutation rather than a degenerate commit: it appends no journal
 * event, publishes no root, and its revision is authoritative rather than
 * proposed. `metadata` is `null` to clear, which is a different act from
 * writing an empty object — clearing removes the row and the next replacement
 * starts counting again.
 *
 * The expected root travels with it so the owner can refuse a replacement
 * proposed against a frontier that has moved, the same way a commit is refused.
 */
export interface RetrievalCommand extends CommandEnvelope {
  readonly command: "retrieval";
  readonly expectedWorkspaceRootId: string;
  /** Canonical JSON, already encoded by the runner, or `null` to clear. */
  readonly metadata: string | null;
}

/**
 * One page of the document executions this run has begun.
 *
 * Anchored like the journal: the first page fixes the last execution that
 * existed when the read began, and every later page is constrained to it, so an
 * execution started while the read is in flight cannot appear halfway through.
 */
export interface ExecutionsCommand extends CommandEnvelope {
  readonly command: "executions";
  /** The terminal sequence this snapshot is anchored to, or `null` for empty. */
  readonly anchor: number | null;
  /** The sequence the previous page ended at, or `null` for the first page. */
  readonly after: number | null;
}

/** One coherent admitted state, asked for exactly once per invocation. */
export interface MappingsCommand extends CommandEnvelope {
  readonly command: "mappings";
}

/**
 * Find this run, or create it exactly once.
 *
 * `creation` absent is a lookup and makes nothing. Present, it is the run's
 * complete immutable identity, and repeating it is how a caller addresses the
 * same run again rather than a second attempt at making one.
 */
export interface OpenCommand extends CommandEnvelope {
  readonly command: "open";
  readonly runId: string;
  readonly creation: CreateWorkflowRunRequest | null;
}

/** Begin one document execution under the live acquisition. */
export interface BeginCommand extends CommandEnvelope {
  readonly command: "begin";
  readonly runId: string;
  readonly action: "start" | "resume";
  readonly creation: CreateWorkflowRunRequest | null;
  /**
   * Where this run's definition can be fetched from again, when it is being
   * created.
   *
   * Replaceable state rather than identity, so it travels beside the creation
   * instead of inside it: a run is not a different run for having been fetched
   * from somewhere else.
   */
  readonly retrieval: string | null;
  /**
   * The execution's identity, minted by the runner.
   *
   * Minted there rather than here so the command is the same bytes on a retry:
   * an owner that invented one would begin a second execution for a request it
   * had already answered.
   */
  readonly executionId: string;
}

/** Make one run terminal, following what it retains. */
export interface CancelCommand extends CommandEnvelope {
  readonly command: "cancel";
  readonly runId: string;
}

/** The sections a fork's parts arrive in, each in its own order. */
export type ForkSection = "inherited" | "roots" | "manifests" | "blobs" | "checkouts";

/** One part of a fork, as the runner offers it. */
export interface ForkPart {
  readonly section: ForkSection;
  readonly position: number;
  readonly part: Record<string, unknown>;
}

/** What the final command says the staged selection should add up to. */
export interface ForkCounts {
  readonly inherited: number;
  readonly roots: number;
  readonly manifests: number;
  readonly blobs: number;
  readonly checkouts: number;
}

/** Which committed checkpoint of which run this fork continues. */
export interface ForkOrigin {
  readonly sourceRunId: string;
  readonly checkpointEventId: string;
  readonly checkpointWorkspaceRootId: string;
  readonly runRecordWorkspaceRootId: string;
  readonly rootImportWorkspaceRootId: string;
  /** The source selection's own anchor, kept with the lineage's evidence. */
  readonly anchor: string;
}

/**
 * Offer one part of a fork's source, before any of it is a run.
 *
 * Scratch belonging to this connection. A part says where it stands in its
 * section so the final command can tell a complete transfer from a partial one.
 */
export interface ForkStageCommand extends CommandEnvelope {
  readonly command: "fork-stage";
  readonly section: ForkSection;
  readonly position: number;
  readonly part: Record<string, unknown>;
}

/** Commit the offered parts as one destination run and its first execution. */
export interface ForkCommand extends CommandEnvelope {
  readonly command: "fork";
  readonly runId: string;
  readonly creation: CreateWorkflowRunRequest;
  readonly retrieval: string | null;
  readonly origin: ForkOrigin;
  readonly counts: ForkCounts;
  readonly runRecord: DurableEvent;
  readonly rootImport: DurableEvent;
  readonly executionId: string;
}

/**
 * Take up a destination that already holds this fork.
 *
 * No origin and no counts: a committed fork is independent of the run it was
 * copied from, so continuing one asks only what the destination itself
 * retains.
 */
export interface ForkContinueCommand extends CommandEnvelope {
  readonly command: "fork-continue";
  readonly runId: string;
  readonly creation: CreateWorkflowRunRequest;
  /** Which fork this claims to be, as the destination retains it. */
  readonly origin: ForkContinuationOrigin;
  readonly runRecord: DurableEvent;
  readonly rootImport: DurableEvent;
  readonly executionId: string;
}

/**
 * The identity a continuation claims, compared against retained state.
 *
 * No anchor and no counts: those describe a copy in flight. What a destination
 * that already holds the fork can be held to is where it came from and what it
 * wrote for itself.
 */
export interface ForkContinuationOrigin {
  readonly sourceRunId: string;
  readonly checkpointEventId: string;
}

export interface SettleCommand extends CommandEnvelope {
  readonly command: "settle";
  readonly completion: DocumentExecutionCompletion;
  readonly expectedWorkspaceRootId: string;
}

export type RunnerCommand =
  | FrontierCommand
  | JournalCommand
  | RootCommand
  | ContentCommand
  | StageCommand
  | CommitCommand
  | RetrievalCommand
  | ExecutionsCommand
  | MappingsCommand
  | OpenCommand
  | BeginCommand
  | CancelCommand
  | SettleCommand
  | ForkStageCommand
  | ForkCommand
  | ForkContinueCommand;

export type CommandResult =
  | { readonly id: string; readonly outcome: "performed"; readonly value: unknown }
  | { readonly id: string; readonly outcome: "refused"; readonly refusal: string };

const MAX_ID = 128;
const MAX_EVENTS = 4096;
const ENVELOPE = ["id", "command"];
const MEMBERS: Record<CommandName, readonly string[]> = {
  frontier: ENVELOPE,
  journal: [...ENVELOPE, "anchorEventId", "afterEventId"],
  root: [...ENVELOPE, "workspaceRootId"],
  content: [...ENVELOPE, "workspaceRootId", "kind", "digest", "sourceManifest"],
  stage: [...ENVELOPE, "kind", "digest", "bytes"],
  commit: [
    ...ENVELOPE,
    "expectedWorkspaceRootId",
    "expectedJournalEventId",
    "publication",
    "mappings",
    "events",
  ],
  retrieval: [...ENVELOPE, "expectedWorkspaceRootId", "metadata"],
  executions: [...ENVELOPE, "anchor", "after"],
  mappings: ENVELOPE,
  open: [...ENVELOPE, "runId", "creation"],
  begin: [...ENVELOPE, "runId", "action", "creation", "retrieval", "executionId"],
  cancel: [...ENVELOPE, "runId"],
  settle: [...ENVELOPE, "completion", "expectedWorkspaceRootId"],
  "fork-stage": [...ENVELOPE, "section", "position", "part"],
  "fork-continue": [
    ...ENVELOPE,
    "runId",
    "creation",
    "origin",
    "runRecord",
    "rootImport",
    "executionId",
  ],
  fork: [
    ...ENVELOPE,
    "runId",
    "creation",
    "retrieval",
    "origin",
    "counts",
    "runRecord",
    "rootImport",
    "executionId",
  ],
};

function object(value: unknown): Map<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CommandError("not-an-object");
  }
  return new Map(Object.entries(value));
}

function closed(members: Map<string, unknown>, allowed: readonly string[]): void {
  for (const key of members.keys()) {
    if (!allowed.includes(key)) {
      throw new CommandError("unknown-member");
    }
  }
  if (members.size !== allowed.length) {
    throw new CommandError("malformed-member");
  }
}

function text(
  members: Map<string, unknown>,
  key: string,
  maximum = Number.MAX_SAFE_INTEGER,
): string {
  const value = members.get(key);
  if (typeof value !== "string" || value === "" || value.length > maximum) {
    throw new CommandError(
      value !== "" && typeof value === "string" ? "too-large" : "malformed-member",
    );
  }
  return value;
}

function nullableText(members: Map<string, unknown>, key: string): string | null {
  const value = members.get(key);
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || value === "") {
    throw new CommandError("malformed-member");
  }
  return value;
}

function digest(members: Map<string, unknown>, key: string): string {
  const value = members.get(key);
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new CommandError("malformed-member");
  }
  return value;
}

function kind(members: Map<string, unknown>): ContentKind {
  const value = members.get("kind");
  if (value !== "manifest" && value !== "blob") {
    throw new CommandError("malformed-member");
  }
  return value;
}

/**
 * The exact serialized events a proposal appends.
 *
 * A record is not admitted because it is a non-empty string, and not because
 * SQLite will accept it as JSON. It is parsed with the authoritative durable
 * event parser and then serialized again, and the result must be the same bytes
 * that arrived, terminating newline included.
 *
 * That round trip is the point. Retaining something that parses as JSON but not
 * as an event would create history a later read cannot understand, and the run
 * would become unreplayable at exactly the moment it was told it had committed.
 * Re-encoding a nearly-right record would be worse: the owner would retain
 * something the runner never proposed.
 */
/** A physical sequence, which is a positive whole number or nothing. */
function sequence(members: Map<string, unknown>, key: string): number | null {
  const value = members.get(key);
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new CommandError("malformed-member");
  }
  return value;
}

function eventRecords(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new CommandError("malformed-member");
  }
  if (value.length > MAX_EVENTS) {
    throw new CommandError("too-large");
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || entry === "") {
      throw new CommandError("malformed-member");
    }
    const parsed = parseDurableEvent(entry);
    if (!parsed.ok || serializeDurableEvent(parsed.value) !== entry) {
      throw new CommandError("malformed-member");
    }
    return entry;
  });
}

export function parseCommand(raw: string): RunnerCommand {
  if (new TextEncoder().encode(raw).length > MAX_MESSAGE_BYTES) {
    throw new CommandError("too-large");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new CommandError("not-an-object");
  }
  const members = object(decoded);
  const id = text(members, "id", MAX_ID);
  const command = members.get("command");
  if (
    command !== "frontier" &&
    command !== "journal" &&
    command !== "root" &&
    command !== "content" &&
    command !== "stage" &&
    command !== "commit" &&
    command !== "retrieval" &&
    command !== "executions" &&
    command !== "mappings" &&
    command !== "open" &&
    command !== "begin" &&
    command !== "cancel" &&
    command !== "settle" &&
    command !== "fork-stage" &&
    command !== "fork" &&
    command !== "fork-continue"
  ) {
    throw new CommandError("unknown-command");
  }
  closed(members, MEMBERS[command]);

  if (command === "frontier") {
    return { id, command };
  }
  if (command === "journal") {
    return {
      id,
      command,
      anchorEventId: nullableText(members, "anchorEventId"),
      afterEventId: nullableText(members, "afterEventId"),
    };
  }
  if (command === "root") {
    return { id, command, workspaceRootId: digest(members, "workspaceRootId") };
  }
  if (command === "content") {
    const contentKind = kind(members);
    if (contentKind === "manifest" && members.get("sourceManifest") !== null) {
      throw new CommandError("malformed-member");
    }
    const sourceManifest = contentKind === "manifest" ? null : digest(members, "sourceManifest");
    return {
      id,
      command,
      workspaceRootId: digest(members, "workspaceRootId"),
      kind: contentKind,
      digest: digest(members, "digest"),
      sourceManifest,
    };
  }
  if (command === "stage") {
    return {
      id,
      command,
      kind: kind(members),
      digest: digest(members, "digest"),
      bytes: text(members, "bytes", Math.ceil((MAX_CONTENT_BYTES * 4) / 3) + 4),
    };
  }
  if (command === "retrieval") {
    const metadata = members.get("metadata");
    if (metadata !== null && (typeof metadata !== "string" || metadata === "")) {
      throw new CommandError("malformed-member");
    }
    if (metadata !== null && new TextEncoder().encode(metadata).length > MAX_MESSAGE_BYTES) {
      throw new CommandError("too-large");
    }
    return {
      id,
      command,
      expectedWorkspaceRootId: digest(members, "expectedWorkspaceRootId"),
      metadata,
    };
  }
  if (command === "mappings") {
    return { id, command };
  }
  if (command === "open") {
    const runId = text(members, "runId", MAX_RUN_ID);
    const offered = members.get("creation");
    if (offered === null) {
      return { id, command, runId, creation: null };
    }
    // Parsed through the shared request parser, so what the owner will retain
    // is what this build calls a creation request rather than an object that
    // resembles one.
    const creation = parseCreateRequest(offered);
    if (!creation.ok || creation.value.runId !== runId) {
      throw new CommandError("malformed-member");
    }
    return { id, command, runId, creation: creation.value };
  }
  if (command === "begin") {
    const runId = text(members, "runId", MAX_RUN_ID);
    const action = members.get("action");
    if (action !== "start" && action !== "resume") {
      throw new CommandError("malformed-member");
    }
    const offered = members.get("creation");
    let creation: CreateWorkflowRunRequest | null = null;
    if (offered !== null) {
      const parsed = parseCreateRequest(offered);
      if (!parsed.ok || parsed.value.runId !== runId) {
        throw new CommandError("malformed-member");
      }
      creation = parsed.value;
    }
    // A start that creates carries its creation; a resume never does.
    if (action === "resume" && creation !== null) {
      throw new CommandError("malformed-member");
    }
    return {
      id,
      command,
      runId,
      action,
      creation,
      retrieval: retrieval(members.get("retrieval"), creation),
      executionId: text(members, "executionId", MAX_RUN_ID),
    };
  }
  if (command === "cancel") {
    return { id, command, runId: text(members, "runId", MAX_RUN_ID) };
  }
  if (command === "fork-stage") {
    const section = members.get("section");
    if (
      section !== "inherited" &&
      section !== "roots" &&
      section !== "manifests" &&
      section !== "blobs" &&
      section !== "checkouts"
    ) {
      throw new CommandError("malformed-member");
    }
    const part = members.get("part");
    if (part === null || typeof part !== "object" || Array.isArray(part)) {
      throw new CommandError("malformed-member");
    }
    return {
      id,
      command,
      section,
      position: whole(members.get("position")),
      part: Object.fromEntries(Object.entries(part)),
    };
  }
  if (command === "fork-continue") {
    const runId = text(members, "runId", MAX_RUN_ID);
    const creation = parseCreateRequest(members.get("creation"));
    if (!creation.ok || creation.value.runId !== runId) {
      throw new CommandError("malformed-member");
    }
    return {
      id,
      command,
      runId,
      creation: creation.value,
      origin: continuationOrigin(members.get("origin")),
      runRecord: forkEvent(members.get("runRecord")),
      rootImport: forkEvent(members.get("rootImport")),
      executionId: text(members, "executionId", MAX_RUN_ID),
    };
  }
  if (command === "fork") {
    const runId = text(members, "runId", MAX_RUN_ID);
    const creation = parseCreateRequest(members.get("creation"));
    if (!creation.ok || creation.value.runId !== runId) {
      throw new CommandError("malformed-member");
    }
    return {
      id,
      command,
      runId,
      creation: creation.value,
      retrieval: retrieval(members.get("retrieval"), creation.value),
      origin: origin(members.get("origin")),
      counts: counts(members.get("counts")),
      runRecord: forkEvent(members.get("runRecord")),
      rootImport: forkEvent(members.get("rootImport")),
      executionId: text(members, "executionId", MAX_RUN_ID),
    };
  }
  if (command === "executions") {
    const anchor = sequence(members, "anchor");
    const after = sequence(members, "after");
    if (anchor === null && after !== null) {
      // An empty snapshot has nothing to continue from.
      throw new CommandError("malformed-member");
    }
    if (anchor !== null && after !== null && after >= anchor) {
      throw new CommandError("malformed-member");
    }
    return { id, command, anchor, after };
  }
  if (command === "settle") {
    const completion = parseDocumentExecutionCompletion(members.get("completion"));
    if (!completion.ok) {
      throw new CommandError("malformed-member");
    }
    return {
      id,
      command,
      completion: completion.value,
      expectedWorkspaceRootId: digest(members, "expectedWorkspaceRootId"),
    };
  }
  return {
    id,
    command,
    expectedWorkspaceRootId: digest(members, "expectedWorkspaceRootId"),
    expectedJournalEventId: nullableText(members, "expectedJournalEventId"),
    publication: publication(members.get("publication")),
    mappings: mappings(members.get("mappings")),
    events: eventRecords(members.get("events")),
  };
}

/**
 * The retrieval metadata a creation carries, canonically encoded.
 *
 * Only a creating request may carry one: a resume is not creating anything for
 * it to belong to. The value is held to the same JSON rules every retained
 * record is, and to the same bound one message is.
 */
function retrieval(value: unknown, creation: CreateWorkflowRunRequest | null): string | null {
  if (value === null) {
    return null;
  }
  if (creation === null) {
    throw new CommandError("malformed-member");
  }
  const encoded = canonicalJson(
    parseJsonValue(value, "$.retrieval", () => new CommandError("malformed-member")),
  );
  if (new TextEncoder().encode(encoded).length > MAX_MESSAGE_BYTES) {
    throw new CommandError("too-large");
  }
  return encoded;
}

/** A whole count, as a member rather than a column. */
function whole(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CommandError("malformed-member");
  }
  return value;
}

/** Where a fork came from: one source, one checkpoint, three head roots. */
function origin(value: unknown): ForkOrigin {
  const found = object(value);
  closed(found, [
    "sourceRunId",
    "checkpointEventId",
    "checkpointWorkspaceRootId",
    "runRecordWorkspaceRootId",
    "rootImportWorkspaceRootId",
    "anchor",
  ]);
  return {
    sourceRunId: text(found, "sourceRunId", MAX_RUN_ID),
    checkpointEventId: text(found, "checkpointEventId", MAX_ID),
    checkpointWorkspaceRootId: digest(found, "checkpointWorkspaceRootId"),
    runRecordWorkspaceRootId: digest(found, "runRecordWorkspaceRootId"),
    rootImportWorkspaceRootId: digest(found, "rootImportWorkspaceRootId"),
    anchor: digest(found, "anchor"),
  };
}

/** Which fork a continuation claims to be continuing. */
function continuationOrigin(value: unknown): ForkContinuationOrigin {
  const found = object(value);
  closed(found, ["sourceRunId", "checkpointEventId"]);
  return {
    sourceRunId: text(found, "sourceRunId", MAX_RUN_ID),
    checkpointEventId: text(found, "checkpointEventId", MAX_ID),
  };
}

/** How many parts each section should have arrived in. */
function counts(value: unknown): ForkCounts {
  const found = object(value);
  closed(found, ["inherited", "roots", "manifests", "blobs", "checkouts"]);
  return {
    inherited: whole(found.get("inherited")),
    roots: whole(found.get("roots")),
    manifests: whole(found.get("manifests")),
    blobs: whole(found.get("blobs")),
    checkouts: whole(found.get("checkouts")),
  };
}

/** One of the two records a fork writes for itself. */
function forkEvent(value: unknown): DurableEvent {
  if (typeof value !== "string" || value === "") {
    throw new CommandError("malformed-member");
  }
  if (new TextEncoder().encode(value).length > MAX_MESSAGE_BYTES) {
    throw new CommandError("too-large");
  }
  const parsed = parseDurableEvent(value);
  if (!parsed.ok) {
    throw new CommandError("malformed-member");
  }
  return parsed.value;
}

/**
 * The Workspace half of a proposal, or its absence.
 *
 * `null` is a journal-only transaction and is admitted as such. Everything else
 * must be a complete proposal: an identity, the canonical manifest that
 * identity is supposed to be the digest of, and the exact inventory. Whether
 * the identity really is that digest, and whether the inventory really is the
 * closure, is the owner's to recompute — this only decides whether the request
 * is shaped like a proposal at all.
 */
function publication(value: unknown): ProposedPublication | null {
  if (value === null) {
    return null;
  }
  const members = object(value);
  closed(members, ["proposedWorkspaceRootId", "proposedManifest", "content"]);
  const manifest = members.get("proposedManifest");
  if (typeof manifest !== "string" || manifest === "") {
    throw new CommandError("malformed-member");
  }
  if (new TextEncoder().encode(manifest).length > MAX_ROOT_MANIFEST_BYTES) {
    throw new CommandError("too-large");
  }
  return {
    proposedWorkspaceRootId: digest(members, "proposedWorkspaceRootId"),
    proposedManifest: manifest,
    content: pieces(members.get("content")),
  };
}

/**
 * The inventory, in the order it must arrive.
 *
 * Canonical order and no repeats, checked here rather than sorted into shape: a
 * proposal that named one piece twice, or named them in an order this build did
 * not produce, is not the proposal the runner computed its identity over.
 */
function pieces(value: unknown): ProposedPiece[] {
  if (!Array.isArray(value)) {
    throw new CommandError("malformed-member");
  }
  if (value.length > MAX_PROPOSED_PIECES) {
    throw new CommandError("too-large");
  }
  const found: ProposedPiece[] = [];
  let previous: string | undefined;
  for (const entry of value) {
    const members = object(entry);
    closed(members, ["kind", "digest", "size"]);
    const size = members.get("size");
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
      throw new CommandError("malformed-member");
    }
    if (size > MAX_CONTENT_BYTES) {
      throw new CommandError("too-large");
    }
    const piece: ProposedPiece = {
      kind: kind(members),
      digest: digest(members, "digest"),
      size,
    };
    const ordering = `${piece.kind}:${piece.digest}`;
    if (previous !== undefined && ordering <= previous) {
      throw new CommandError("malformed-member");
    }
    previous = ordering;
    found.push(piece);
  }
  return found;
}

/**
 * The retained mappings a proposal carries, read through the shared parsers.
 *
 * The parsers are the ones the local host holds its own rows to. A private
 * approximation here would be the two hosts disagreeing about what a retained
 * Repository is, and the owner would be the one that found out.
 */
function mappings(value: unknown): ProposedMapping[] {
  if (!Array.isArray(value)) {
    throw new CommandError("malformed-member");
  }
  if (value.length > MAX_MAPPINGS) {
    throw new CommandError("too-large");
  }
  return value.map((entry) => {
    const members = object(entry);
    const which = members.get("kind");
    closed(members, which === "repository" ? ["kind", "record", "locator"] : ["kind", "record"]);
    const offered = members.get("record");
    if (which === "repository") {
      const record = parseRepositoryRecord(offered);
      const offeredLocator = members.get("locator");
      if (record === undefined || typeof offeredLocator !== "string") {
        throw new CommandError("malformed-member");
      }
      // Admitted first, by the same closed allowlist the local host uses. A
      // matching fingerprint says the two values agree with each other; it says
      // nothing about whether the locator is one this system will ever hand to
      // Git, and an authenticated proposal must not be able to retain a
      // credential-bearing URL or an executable transport form.
      const locator = admitLocator(offeredLocator);
      if (locator === undefined || locatorFingerprintOf(locator) !== record.locatorFingerprint) {
        throw new CommandError("malformed-member");
      }
      return { kind: which, record, locator };
    }
    if (which === "worktree") {
      const record = parseWorktreeRecord(offered);
      if (record === undefined) {
        throw new CommandError("malformed-member");
      }
      return { kind: which, record };
    }
    if (which === "agent-session") {
      const record = parseAgentSessionRecord(offered);
      if (record === undefined) {
        throw new CommandError("malformed-member");
      }
      return { kind: which, record };
    }
    throw new CommandError("malformed-member");
  });
}
