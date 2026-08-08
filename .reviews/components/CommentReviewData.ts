import type { Operation } from "effection";
import { fetch } from "@effectionx/fetch";
import type { PR } from "@executablemd/code-review-agent";
import { env as runtimeEnv } from "@executablemd/runtime";

export const props = {
  type: "object",
  properties: { pr: { type: "object" } },
  required: ["pr"],
  additionalProperties: false,
};

const locationProperties = {
  file: { type: "string" },
  lineNumber: { type: "number" },
};

const replyProperties = {
  ...locationProperties,
  comment: { type: "string" },
  botCommentId: { type: "number" },
  replyText: { type: "string" },
  replyId: { type: "number" },
  alreadyProcessed: { type: "boolean" },
};

export const returns = {
  type: "object",
  properties: {
    pairs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          comment: { type: "string" },
          code: { type: "string" },
          ...locationProperties,
        },
        required: ["comment", "code", "file", "lineNumber"],
        additionalProperties: false,
      },
    },
    hasPairs: { type: "boolean" },
    pairsText: { type: "string" },
    previousFindings: {
      type: "array",
      items: {
        type: "object",
        properties: locationProperties,
        required: ["file", "lineNumber"],
        additionalProperties: false,
      },
    },
    dismissedReplies: {
      type: "array",
      items: {
        type: "object",
        properties: replyProperties,
        required: ["file", "lineNumber", "replyText"],
        additionalProperties: false,
      },
    },
    repliesForClassification: {
      type: "array",
      items: {
        type: "object",
        properties: replyProperties,
        required: ["file", "lineNumber", "replyText"],
        additionalProperties: false,
      },
    },
    hasRepliesToClassify: { type: "boolean" },
    repliesText: { type: "string" },
  },
  required: [
    "pairs",
    "hasPairs",
    "pairsText",
    "previousFindings",
    "dismissedReplies",
    "repliesForClassification",
    "hasRepliesToClassify",
    "repliesText",
  ],
  additionalProperties: false,
};

interface CommentReviewProps {
  pr: PR;
}

interface Pair {
  comment: string;
  code: string;
  file: string;
  lineNumber: number;
}

interface Reply {
  file: string;
  lineNumber: number;
  comment?: string;
  botCommentId?: number;
  replyText: string;
  replyId?: number;
  alreadyProcessed?: boolean;
}

interface Location {
  file: string;
  lineNumber: number;
  comment: string;
}

interface ReviewData {
  pairs: Pair[];
  hasPairs: boolean;
  pairsText: string;
  previousFindings: { file: string; lineNumber: number }[];
  dismissedReplies: Reply[];
  repliesForClassification: Reply[];
  hasRepliesToClassify: boolean;
  repliesText: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value === "string") {
    return value;
  }
  return undefined;
}

function numberValue(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === "number") {
    return value;
  }
  return undefined;
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry) => isRecord(entry));
}

function nonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function userLogin(record: Record<string, unknown>): string | undefined {
  const { user } = record;
  if (isRecord(user)) {
    return stringValue(user, "login");
  }
  return undefined;
}

function userType(record: Record<string, unknown>): string | undefined {
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

function commentPayload(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every((entry) => isRecord(entry))) {
    throw new Error("GitHub comments response was not an array");
  }
  return value;
}

function* githubApi(): Operation<string | undefined> {
  const token = yield* runtimeEnv("GITHUB_TOKEN");
  const repository = yield* runtimeEnv("GITHUB_REPOSITORY");
  const number = yield* runtimeEnv("PR_NUMBER");
  if (!nonEmpty(token) || !nonEmpty(repository) || !nonEmpty(number)) {
    return undefined;
  }
  const [owner, name] = repository.split("/");
  if (nonEmpty(owner) && nonEmpty(name)) {
    return `https://api.github.com/repos/${owner}/${name}`;
  }
  return undefined;
}

function pairsFor(pr: PR): Pair[] {
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

function* fetchReplyReactions(api: string, reply: Reply): Operation<boolean> {
  try {
    const reactions = records(
      yield* fetch(`${api}/pulls/comments/${reply.replyId}/reactions`).expect().json(),
    );
    return reactions.some(
      (reaction) => userLogin(reaction) === "github-actions[bot]" && reaction.content === "+1",
    );
  } catch {
    return false;
  }
}

function* collectReplies(
  api: string,
  comments: Record<string, unknown>[],
  botCommentMap: Map<number, Location>,
): Operation<{ dismissed: Reply[]; pending: Reply[] }> {
  const dismissed: Reply[] = [];
  const pending: Reply[] = [];
  for (const reply of comments) {
    const entry = yield* replyForClassification(api, reply, botCommentMap);
    if (entry !== undefined) {
      if (entry.alreadyProcessed) {
        dismissed.push(entry);
      } else {
        pending.push(entry);
      }
    }
  }
  return { dismissed, pending };
}

function replyLocation(
  reply: Record<string, unknown>,
  botCommentMap: Map<number, Location>,
): Location | undefined {
  const parentId = numberValue(reply, "in_reply_to_id");
  if (parentId === undefined) {
    return undefined;
  }
  return botCommentMap.get(parentId);
}

function* replyForClassification(
  api: string,
  reply: Record<string, unknown>,
  botCommentMap: Map<number, Location>,
): Operation<Reply | undefined> {
  const parentId = numberValue(reply, "in_reply_to_id");
  const location = replyLocation(reply, botCommentMap);
  const replyText = stringValue(reply, "body");
  const replyId = numberValue(reply, "id");
  if (
    location === undefined ||
    userType(reply) === "Bot" ||
    replyText === undefined ||
    replyId === undefined
  ) {
    return undefined;
  }

  const entry: Reply = { ...location, botCommentId: parentId, replyText, replyId };
  if (yield* fetchReplyReactions(api, entry)) {
    return { ...entry, alreadyProcessed: true };
  }
  return entry;
}

interface CommentLocations {
  botCommentMap: Map<number, Location>;
  previousFindings: { file: string; lineNumber: number }[];
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

function commentLocations(comments: Record<string, unknown>[]): CommentLocations {
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

function formatPairs(pairs: Pair[], hasPairs: boolean): string {
  if (!hasPairs) {
    return "";
  }
  return pairs
    .map((pair, index) => `[${index}] COMMENT: ${pair.comment}\nCODE: ${pair.code}`)
    .join("\n---\n");
}

function formatReplies(replies: Reply[]): string {
  return replies
    .map(
      (reply, index) =>
        `[${index}] FILE: ${reply.file}:${reply.lineNumber}\nREPLY: "${reply.replyText}"`,
    )
    .join("\n---\n");
}

interface ReviewDataParts {
  pairs: Pair[];
  previousFindings: { file: string; lineNumber: number }[];
  dismissedReplies: Reply[];
  repliesForClassification: Reply[];
}

function reviewData({
  pairs,
  previousFindings,
  dismissedReplies,
  repliesForClassification,
}: ReviewDataParts): ReviewData {
  const hasPairs = pairs.length >= 3;
  return {
    pairs,
    hasPairs,
    pairsText: formatPairs(pairs, hasPairs),
    previousFindings,
    dismissedReplies,
    repliesForClassification,
    hasRepliesToClassify: repliesForClassification.length > 0,
    repliesText: formatReplies(repliesForClassification),
  };
}

function emptyReviewData(pairs: Pair[]): ReviewData {
  return reviewData({
    pairs,
    previousFindings: [],
    dismissedReplies: [],
    repliesForClassification: [],
  });
}

function* fetchedReviewData(api: string, number: string, pairs: Pair[]): Operation<ReviewData> {
  const comments = commentPayload(
    yield* fetch(`${api}/pulls/${number}/comments?per_page=100`).expect().json(),
  );
  const locations = commentLocations(comments);
  const replies = yield* collectReplies(api, comments, locations.botCommentMap);
  return reviewData({
    pairs,
    previousFindings: locations.previousFindings,
    dismissedReplies: replies.dismissed,
    repliesForClassification: replies.pending,
  });
}

function* reviewDataFor(pr: PR): Operation<ReviewData> {
  const pairs = pairsFor(pr);
  const api = yield* githubApi();
  if (api === undefined) {
    return emptyReviewData(pairs);
  }
  const number = yield* runtimeEnv("PR_NUMBER");
  if (!nonEmpty(number)) {
    return emptyReviewData(pairs);
  }
  return yield* fetchedReviewData(api, number, pairs);
}

export default function* CommentReviewData({ pr }: CommentReviewProps): Operation<ReviewData> {
  return yield* reviewDataFor(pr);
}
