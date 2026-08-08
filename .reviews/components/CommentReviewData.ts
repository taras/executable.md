import type { Operation } from "effection";
import { fetch } from "@effectionx/fetch";
import { env as runtimeEnv } from "@executablemd/runtime";
import type { PR } from "@executablemd/code-review-agent";

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
  previousFindings: Array<{ file: string; lineNumber: number }>;
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
  return typeof value === "string" ? value : undefined;
}

function numberValue(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function userLogin(record: Record<string, unknown>): string | undefined {
  const user = record.user;
  return isRecord(user) ? stringValue(user, "login") : undefined;
}

function userType(record: Record<string, unknown>): string | undefined {
  const user = record.user;
  return isRecord(user) ? stringValue(user, "type") : undefined;
}

function isBotReview(record: Record<string, unknown>): boolean {
  return (
    userLogin(record) === "github-actions[bot]" &&
    (stringValue(record, "body")?.includes("Redundant comment") ?? false)
  );
}

function commentPayload(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error("GitHub comments response was not an array");
  }
  return value;
}

function* githubApi(): Operation<string | undefined> {
  const token = yield* runtimeEnv("GITHUB_TOKEN");
  const repository = yield* runtimeEnv("GITHUB_REPOSITORY");
  const number = yield* runtimeEnv("PR_NUMBER");
  if (!token || !repository || !number) {
    return undefined;
  }
  const [owner, name] = repository.split("/");
  return owner && name ? `https://api.github.com/repos/${owner}/${name}` : undefined;
}

function pairsFor(pr: PR): Pair[] {
  const pairs: Pair[] = [];
  const lines = pr.added.filter((line) => !line.isTest);
  for (let i = 0; i < lines.length - 1; i++) {
    const current = lines[i].content.trim();
    const next = lines[i + 1].content.trim();
    if (current.startsWith("//") && !next.startsWith("//") && next.length > 0) {
      pairs.push({
        comment: current,
        code: next,
        file: lines[i].file,
        lineNumber: lines[i].lineNumber,
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
    const parentId = numberValue(reply, "in_reply_to_id");
    const location = parentId === undefined ? undefined : botCommentMap.get(parentId);
    if (!location || userType(reply) === "Bot") {
      continue;
    }
    const replyText = stringValue(reply, "body");
    const replyId = numberValue(reply, "id");
    if (!replyText || replyId === undefined) {
      continue;
    }
    const entry: Reply = { ...location, botCommentId: parentId, replyText, replyId };
    if (yield* fetchReplyReactions(api, entry)) {
      dismissed.push({ ...entry, alreadyProcessed: true });
    } else {
      pending.push(entry);
    }
  }
  return { dismissed, pending };
}

export default function* CommentReviewData({ pr }: CommentReviewProps): Operation<ReviewData> {
  const pairs = pairsFor(pr);
  const api = yield* githubApi();
  const previousFindings: Array<{ file: string; lineNumber: number }> = [];
  const dismissedReplies: Reply[] = [];
  const repliesForClassification: Reply[] = [];

  if (api) {
    const number = yield* runtimeEnv("PR_NUMBER");
    const comments = commentPayload(
      yield* fetch(`${api}/pulls/${number}/comments?per_page=100`).expect().json(),
    );
    const botComments = comments.filter(isBotReview);
    const botCommentMap = new Map<number, Location>();
    for (const comment of botComments) {
      const id = numberValue(comment, "id");
      const path = stringValue(comment, "path");
      const lineNumber = numberValue(comment, "original_line") ?? numberValue(comment, "line");
      if (id === undefined || !path || lineNumber === undefined) {
        continue;
      }
      const diffHunk = stringValue(comment, "diff_hunk") ?? "";
      const commentLine =
        diffHunk
          .split("\n")
          .filter((line) => line.startsWith("+"))
          .pop() ?? "";
      const location = {
        file: path,
        lineNumber,
        comment: commentLine.replace(/^\+\s*/, "").trim(),
      };
      botCommentMap.set(id, location);
      previousFindings.push({ file: path, lineNumber });
    }
    const replies = yield* collectReplies(api, comments, botCommentMap);
    dismissedReplies.push(...replies.dismissed);
    repliesForClassification.push(...replies.pending);
  }

  const hasPairs = pairs.length >= 3;
  return {
    pairs,
    hasPairs,
    pairsText: hasPairs
      ? pairs
          .map((pair, index) => `[${index}] COMMENT: ${pair.comment}\nCODE: ${pair.code}`)
          .join("\n---\n")
      : "",
    previousFindings,
    dismissedReplies,
    repliesForClassification,
    hasRepliesToClassify: repliesForClassification.length > 0,
    repliesText: repliesForClassification
      .map(
        (reply, index) =>
          `[${index}] FILE: ${reply.file}:${reply.lineNumber}\nREPLY: "${reply.replyText}"`,
      )
      .join("\n---\n"),
  };
}
