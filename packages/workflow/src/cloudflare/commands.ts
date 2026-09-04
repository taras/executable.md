import {
  type DocumentExecutionCompletion,
  parseDocumentExecutionCompletion,
} from "../storage/record.ts";
import { parseDurableEvent, serializeDurableEvent } from "@executablemd/durable-streams";
import { SHA256 } from "../workspace/root-manifest.ts";
import { admitLocator, locatorFingerprintOf } from "../composition/locator.ts";
import {
  parseRepositoryRecord,
  parseWorktreeRecord,
  type RepositoryRecord,
  type WorktreeRecord,
} from "../composition/records.ts";
import { type AgentSessionRecord, parseAgentSessionRecord } from "../storage/agent-session.ts";
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
  | "settle";

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
  | "mapping-conflict";

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
  | SettleCommand;

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
  settle: [...ENVELOPE, "completion", "expectedWorkspaceRootId"],
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
    command !== "settle"
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
