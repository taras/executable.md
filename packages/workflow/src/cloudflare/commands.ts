/**
 * What a runner asks its owner, and what comes back.
 *
 * These records are private to one software-factory release. They are not
 * journaled, exported, authored, or supported across independently versioned
 * builds — admission has already proved both sides are the same build, which is
 * what a wire contract would otherwise be for. Their decomposition is
 * implementation detail and may change with the release that contains it.
 *
 * What is not private is the parsing discipline. Everything arriving from the
 * connection is parsed strictly before it reaches storage: an unknown command,
 * an unknown member, a value of the wrong kind and a value past its bound are
 * each refused whole, and nothing is partially adopted. A permissive read here
 * would be a runner deciding what the owner does.
 */

import {
  type DocumentExecutionCompletion,
  parseDocumentExecutionCompletion,
} from "../storage/record.ts";

/** The commands a runner may send. */
export type CommandName = "frontier" | "materialize" | "commit" | "settle";

/** Why a message was refused before it reached the run. */
export type CommandRefusal =
  | "not-an-object"
  | "unknown-command"
  | "unknown-member"
  | "malformed-member"
  | "too-large";

export class CommandError extends Error {
  override name = "CommandError";

  constructor(readonly refusal: CommandRefusal) {
    // The message a runner sent is not repeated: it arrived from outside and a
    // member name can carry as much as a member value.
    super(`this owner refused a runner command (${refusal})`);
  }
}

/** The envelope every command shares. */
export interface CommandEnvelope {
  /** Distinguishes one request from a retry of the same request. */
  readonly id: string;
  readonly command: CommandName;
}

/** Read the committed run record and current Workspace root. */
export interface FrontierCommand extends CommandEnvelope {
  readonly command: "frontier";
}

/** Ask for the content-addressed bytes of one retained root. */
export interface MaterializeCommand extends CommandEnvelope {
  readonly command: "materialize";
  readonly workspaceRootId: string;
}

/** One closed mutation intent, submitted once, applied atomically or not at all. */
export interface CommitCommand extends CommandEnvelope {
  readonly command: "commit";
  /** The root the runner started from; the owner refuses if it has moved. */
  readonly expectedWorkspaceRootId: string;
  /** The journal frontier the runner read; the owner refuses if it has moved. */
  readonly expectedJournalEventId: string | null;
  /** Content-addressed additions, each named by its own digest. */
  readonly content: readonly ContentChunk[];
  /** The canonical root the runner proposes, recomputed by the owner. */
  readonly proposedWorkspaceRootId: string;
  /** Already-filtered journal events to append, in order. */
  readonly events: readonly string[];
}

/**
 * Publish how a document execution ended, and what the run becomes.
 *
 * The completion is the shared provider-neutral record, parsed with the shared
 * parser rather than a private approximation — the owner and the local host
 * have to agree about what a completion *is*, and two readers of one shape is
 * how they stop agreeing. The expected root is carried so the owner can refuse
 * a settlement proposed against a frontier that has moved.
 */
export interface SettleCommand extends CommandEnvelope {
  readonly command: "settle";
  readonly completion: DocumentExecutionCompletion;
  readonly expectedWorkspaceRootId: string;
}

export interface ContentChunk {
  readonly digest: string;
  /** Base64, because a private transport still carries text. */
  readonly bytes: string;
}

export type RunnerCommand = FrontierCommand | MaterializeCommand | CommitCommand | SettleCommand;

/** The largest message this owner reads at all. */
const MAX_MESSAGE = 8 * 1024 * 1024;

/** The most chunks one commit may carry. */
const MAX_CHUNKS = 4096;

const ENVELOPE = ["id", "command"] as const;

const MEMBERS: Record<CommandName, readonly string[]> = {
  frontier: [...ENVELOPE],
  materialize: [...ENVELOPE, "workspaceRootId"],
  commit: [
    ...ENVELOPE,
    "expectedWorkspaceRootId",
    "expectedJournalEventId",
    "content",
    "proposedWorkspaceRootId",
    "events",
  ],
  settle: [...ENVELOPE, "completion", "expectedWorkspaceRootId"],
};

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CommandError("not-an-object");
  }
  return value as Record<string, unknown>;
}

function text(members: Record<string, unknown>, key: string): string {
  const value = members[key];
  if (typeof value !== "string" || value === "") {
    throw new CommandError("malformed-member");
  }
  return value;
}

function closed(members: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(members)) {
    if (!allowed.includes(key)) {
      throw new CommandError("unknown-member");
    }
  }
}

function chunks(value: unknown): ContentChunk[] {
  if (!Array.isArray(value)) {
    throw new CommandError("malformed-member");
  }
  if (value.length > MAX_CHUNKS) {
    throw new CommandError("too-large");
  }
  return value.map((entry) => {
    const members = object(entry);
    closed(members, ["digest", "bytes"]);
    return { digest: text(members, "digest"), bytes: text(members, "bytes") };
  });
}

function events(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new CommandError("malformed-member");
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || entry === "") {
      throw new CommandError("malformed-member");
    }
    return entry;
  });
}

/** Read one command out of a message nothing has inspected yet. */
export function parseCommand(raw: string): RunnerCommand {
  if (raw.length > MAX_MESSAGE) {
    throw new CommandError("too-large");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new CommandError("not-an-object");
  }
  const members = object(decoded);
  const id = text(members, "id");
  const command = members["command"];
  if (
    command !== "frontier" &&
    command !== "materialize" &&
    command !== "commit" &&
    command !== "settle"
  ) {
    throw new CommandError("unknown-command");
  }
  closed(members, MEMBERS[command]);

  if (command === "frontier") {
    return { id, command };
  }
  if (command === "materialize") {
    return { id, command, workspaceRootId: text(members, "workspaceRootId") };
  }
  if (command === "settle") {
    // The shared parser decides what a completion is. Its failure becomes this
    // transport's own closed refusal: the parser's message names members and
    // values a request supplied, and none of that belongs on the wire.
    const completion = parseDocumentExecutionCompletion(members["completion"]);
    if (!completion.ok) {
      throw new CommandError("malformed-member");
    }
    return {
      id,
      command,
      completion: completion.value,
      expectedWorkspaceRootId: text(members, "expectedWorkspaceRootId"),
    };
  }
  const expectedJournalEventId = members["expectedJournalEventId"];
  if (expectedJournalEventId !== null && typeof expectedJournalEventId !== "string") {
    throw new CommandError("malformed-member");
  }
  return {
    id,
    command,
    expectedWorkspaceRootId: text(members, "expectedWorkspaceRootId"),
    expectedJournalEventId,
    content: chunks(members["content"]),
    proposedWorkspaceRootId: text(members, "proposedWorkspaceRootId"),
    events: events(members["events"]),
  };
}

/**
 * What the owner answers with.
 *
 * A serialized record rather than an Effection `Result`: this crosses a
 * connection, and an `Error` does not survive that. The discriminant is
 * `outcome` for the same reason — there is no in-process result being modelled
 * here, only what one side told the other.
 */
export type CommandResult =
  | { readonly id: string; readonly outcome: "performed"; readonly value: unknown }
  | { readonly id: string; readonly outcome: "refused"; readonly refusal: string };
