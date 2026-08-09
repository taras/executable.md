import type { PR } from "./types.ts";

export interface Pair {
  comment: string;
  code: string;
  file: string;
  lineNumber: number;
}

export interface Reply {
  file: string;
  lineNumber: number;
  comment?: string;
  botCommentId?: number;
  replyText: string;
  replyId?: number;
  alreadyProcessed?: boolean;
}

export interface Location {
  file: string;
  lineNumber: number;
  comment: string;
}

export interface ReviewData {
  pairs: Pair[];
  hasPairs: boolean;
  pairsText: string;
  previousFindings: { file: string; lineNumber: number }[];
  dismissedReplies: Reply[];
  repliesForClassification: Reply[];
  hasRepliesToClassify: boolean;
  repliesText: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value === "string") {
    return value;
  }
  return undefined;
}

export function numberValue(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === "number") {
    return value;
  }
  return undefined;
}

export function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry) => isRecord(entry));
}

export function nonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

export function userLogin(record: Record<string, unknown>): string | undefined {
  const { user } = record;
  if (isRecord(user)) {
    return stringValue(user, "login");
  }
  return undefined;
}

export function userType(record: Record<string, unknown>): string | undefined {
  const { user } = record;
  if (isRecord(user)) {
    return stringValue(user, "type");
  }
  return undefined;
}

function isBotReview(record: Record<string, unknown>): boolean {
  return (
    userLogin(record) === "github-actions[bot]" &&
    (stringValue(record, "body")?.includes("Redundant comment") ?? false)
  );
}

export function commentPayload(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every((entry) => isRecord(entry))) {
    throw new Error("GitHub comments response was not an array");
  }
  return value;
}

export function pairsFor(pr: PR): Pair[] {
  const pairs: Pair[] = [];
  const lines = pr.added.filter((line) => !line.isTest);
  for (let index = 0; index < lines.length - 1; index++) {
    const current = lines[index].content.trim();
    const next = lines[index + 1].content.trim();
    if (current.startsWith("//") && !next.startsWith("//") && next.length > 0) {
      pairs.push({
        comment: current,
        code: next,
        file: lines[index].file,
        lineNumber: lines[index].lineNumber,
      });
    }
  }
  return pairs;
}

export function replyLocation(
  reply: Record<string, unknown>,
  botCommentMap: Map<number, Location>,
): Location | undefined {
  const parentId = numberValue(reply, "in_reply_to_id");
  if (parentId === undefined) {
    return undefined;
  }
  return botCommentMap.get(parentId);
}

interface CommentLocationEntry {
  id: number;
  location: Location;
}

function commentLine(diffHunk: string): string {
  const addedLine = diffHunk
    .split("\n")
    .filter((line) => line.startsWith("+"))
    .pop();
  return addedLine?.replace(/^\+\s*/u, "").trim() ?? "";
}

function commentLocation(comment: Record<string, unknown>): CommentLocationEntry | undefined {
  if (!isBotReview(comment)) {
    return undefined;
  }
  const id = numberValue(comment, "id");
  const path = stringValue(comment, "path");
  const lineNumber = numberValue(comment, "original_line") ?? numberValue(comment, "line");
  if (id === undefined || !nonEmpty(path) || lineNumber === undefined) {
    return undefined;
  }
  return {
    id,
    location: {
      file: path,
      lineNumber,
      comment: commentLine(stringValue(comment, "diff_hunk") ?? ""),
    },
  };
}

export function commentLocations(comments: Record<string, unknown>[]): {
  botCommentMap: Map<number, Location>;
  previousFindings: { file: string; lineNumber: number }[];
} {
  const entries = comments
    .map((comment) => commentLocation(comment))
    .filter((entry): entry is CommentLocationEntry => entry !== undefined);
  const botCommentMap = new Map<number, Location>();
  for (const entry of entries) {
    botCommentMap.set(entry.id, entry.location);
  }
  return {
    botCommentMap,
    previousFindings: entries.map(({ location }) => ({
      file: location.file,
      lineNumber: location.lineNumber,
    })),
  };
}

export function formatPairs(pairs: Pair[], hasPairs: boolean): string {
  if (!hasPairs) {
    return "";
  }
  return pairs
    .map((pair, index) => `[${index}] COMMENT: ${pair.comment}\nCODE: ${pair.code}`)
    .join("\n---\n");
}

export function formatReplies(replies: Reply[]): string {
  return replies
    .map(
      (reply, index) =>
        `[${index}] FILE: ${reply.file}:${reply.lineNumber}\nREPLY: "${reply.replyText}"`,
    )
    .join("\n---\n");
}
