import {
  type DocumentExecutionCompletion,
  parseDocumentExecutionCompletion,
} from "../storage/record.ts";
import { SHA256 } from "../workspace/root-manifest.ts";

export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export const MAX_CONTENT_BYTES = 1024 * 1024;
export const MAX_STAGED_BYTES = 2 * 1024 * 1024;
export const MAX_COMMANDS = 256;
export const MAX_LEDGER_BYTES = 2 * 1024 * 1024;
export const JOURNAL_PAGE_ENTRIES = 128;
export const JOURNAL_PAGE_BYTES = 512 * 1024;

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
  | "unavailable";

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

export interface CommitCommand extends CommandEnvelope {
  readonly command: "commit";
  readonly expectedWorkspaceRootId: string;
  readonly expectedJournalEventId: string | null;
  readonly proposedWorkspaceRootId: string;
  readonly events: readonly string[];
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
    "proposedWorkspaceRootId",
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
    proposedWorkspaceRootId: digest(members, "proposedWorkspaceRootId"),
    events: eventRecords(members.get("events")),
  };
}
