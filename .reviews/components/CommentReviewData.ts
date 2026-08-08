import type { Operation } from "effection";
import { fetch } from "@effectionx/fetch";
import type { PR } from "@executablemd/code-review-agent";
import { env as runtimeEnv } from "@executablemd/runtime";
import {
  commentLocations,
  commentPayload,
  formatPairs,
  formatReplies,
  nonEmpty,
  numberValue,
  pairsFor,
  records,
  replyLocation,
  stringValue,
  type Location,
  type Pair,
  type Reply,
  type ReviewData,
  userLogin,
  userType,
} from "../../packages/code-review-agent/src/comment-review-data.ts";

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
      if (entry.alreadyProcessed === true) {
        dismissed.push(entry);
      } else {
        pending.push(entry);
      }
    }
  }
  return { dismissed, pending };
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
