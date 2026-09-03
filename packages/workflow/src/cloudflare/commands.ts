import {
  type DocumentExecutionCompletion,
  parseDocumentExecutionCompletion,
} from "../storage/record.ts";
import { SHA256 } from "../workspace/root-manifest.ts";
import {
  parseRepositoryRecord,
  parseWorktreeRecord,
  type RepositoryRecord,
  type WorktreeRecord,
} from "../composition/records.ts";
import { type AgentSessionRecord, parseAgentSessionRecord } from "../storage/agent-session.ts";

export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export const MAX_CONTENT_BYTES = 1024 * 1024;
export const MAX_STAGED_BYTES = 2 * 1024 * 1024;
export const MAX_COMMANDS = 256;
export const MAX_LEDGER_BYTES = 2 * 1024 * 1024;
export const JOURNAL_PAGE_ENTRIES = 128;
export const JOURNAL_PAGE_BYTES = 512 * 1024;
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
  | { readonly kind: "repository"; readonly record: RepositoryRecord }
  | { readonly kind: "worktree"; readonly record: WorktreeRecord }
  | { readonly kind: "agent-session"; readonly record: AgentSessionRecord };

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
    closed(members, ["kind", "record"]);
    const which = members.get("kind");
    const offered = members.get("record");
    if (which === "repository") {
      const record = parseRepositoryRecord(offered);
      if (record === undefined) {
        throw new CommandError("malformed-member");
      }
      return { kind: which, record };
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
