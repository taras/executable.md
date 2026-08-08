import type { Operation } from "effection";
import type { PR } from "@executablemd/code-review-agent";

const locationProperties = {
  file: { type: "string" },
  lineNumber: { type: "number" },
};

const findingProperties = {
  ...locationProperties,
  comment: { type: "string" },
  code: { type: "string" },
};

const replyProperties = {
  ...locationProperties,
  comment: { type: "string" },
  botCommentId: { type: "number" },
  replyText: { type: "string" },
  replyId: { type: "number" },
  alreadyProcessed: { type: "boolean" },
};

export const props = {
  type: "object",
  properties: {
    pr: { type: "object" },
    data: { type: "object" },
    classificationResult: { type: "string", default: "" },
    sampleResult: { type: "string", default: "" },
  },
  required: ["pr", "data", "classificationResult", "sampleResult"],
  additionalProperties: false,
};

export const returns = {
  type: "object",
  properties: {
    hasChecklist: { type: "boolean" },
    checklistMd: { type: "string" },
    hasFindings: { type: "boolean" },
    pendingFindings: {
      type: "array",
      items: {
        type: "object",
        properties: findingProperties,
        required: ["comment", "code", "file", "lineNumber"],
        additionalProperties: false,
      },
    },
    newDismissReplies: {
      type: "array",
      items: {
        type: "object",
        properties: replyProperties,
        required: ["file", "lineNumber", "replyText"],
        additionalProperties: false,
      },
    },
  },
  required: ["hasChecklist", "checklistMd", "hasFindings", "pendingFindings", "newDismissReplies"],
  additionalProperties: false,
};

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

interface ReviewData {
  pairs: Pair[];
  previousFindings: { file: string; lineNumber: number }[];
  dismissedReplies: Reply[];
  repliesForClassification: Reply[];
}

interface CommentReviewStateProps {
  pr: PR;
  data: ReviewData;
  classificationResult: string;
  sampleResult: string;
}

interface CommentReviewStateValue {
  hasChecklist: boolean;
  checklistMd: string;
  hasFindings: boolean;
  pendingFindings: Pair[];
  newDismissReplies: Reply[];
}

type ChecklistItem =
  | { status: "applied"; file: string; lineNumber: number; label: string }
  | { status: "dismissed"; file: string; lineNumber: number; comment: string; label: string }
  | { status: "pending"; file: string; lineNumber: number; comment: string };

const CLASSIFICATION_PATTERN = /\[(?<index>\d+)\]\s*(?<action>DISMISS|ACCEPT)/giu;
const REDUNDANT_PATTERN = /REDUNDANT\[(?<index>\d+)\]/gu;

function key(file: string, lineNumber: number): string {
  return `${file}:${lineNumber}`;
}

function matchedIndices(input: string, pattern: RegExp): number[] {
  const indices: number[] = [];
  for (const match of input.matchAll(pattern)) {
    const index = Number(match.groups?.index);
    if (Number.isInteger(index)) {
      indices.push(index);
    }
  }
  return indices;
}

function dismissedIndices(input: string): number[] {
  const indices: number[] = [];
  for (const match of input.matchAll(CLASSIFICATION_PATTERN)) {
    if (match.groups?.action?.toUpperCase() === "DISMISS") {
      const index = Number(match.groups?.index);
      if (Number.isInteger(index)) {
        indices.push(index);
      }
    }
  }
  return indices;
}

function dismissedRepliesFor(data: ReviewData, classificationResult: string): Reply[] {
  const dismissedReplies = [...data.dismissedReplies];
  for (const index of dismissedIndices(classificationResult)) {
    const reply = data.repliesForClassification[index];
    if (reply !== undefined) {
      dismissedReplies.push(reply);
    }
  }
  return dismissedReplies;
}

function dismissedSetFor(replies: Reply[]): Set<string> {
  return new Set(replies.map((reply) => key(reply.file, reply.lineNumber)));
}

function appliedFindingsFor(
  data: ReviewData,
  pr: PR,
  dismissedSet: Set<string>,
): { file: string; lineNumber: number }[] {
  const addedLineSet = new Set(pr.added.map((line) => key(line.file, line.lineNumber)));
  return data.previousFindings.filter((finding) => {
    const findingKey = key(finding.file, finding.lineNumber);
    return !addedLineSet.has(findingKey) && !dismissedSet.has(findingKey);
  });
}

function pendingFindingsFor(
  data: ReviewData,
  sampleResult: string,
  dismissedSet: Set<string>,
): Pair[] {
  return matchedIndices(sampleResult, REDUNDANT_PATTERN)
    .map((index) => data.pairs[index])
    .filter(
      (finding): finding is Pair =>
        finding !== undefined && !dismissedSet.has(key(finding.file, finding.lineNumber)),
    );
}

function checklistItemsFor(
  appliedFindings: { file: string; lineNumber: number }[],
  dismissedReplies: Reply[],
  pendingFindings: Pair[],
): ChecklistItem[] {
  return [
    ...appliedFindings.map(
      (finding): ChecklistItem => ({
        status: "applied",
        file: finding.file,
        lineNumber: finding.lineNumber,
        label: "removed",
      }),
    ),
    ...dismissedReplies.map(
      (reply): ChecklistItem => ({
        status: "dismissed",
        file: reply.file,
        lineNumber: reply.lineNumber,
        comment: reply.comment ?? "",
        label: reply.replyText,
      }),
    ),
    ...pendingFindings.map(
      (finding): ChecklistItem => ({
        status: "pending",
        file: finding.file,
        lineNumber: finding.lineNumber,
        comment: finding.comment,
      }),
    ),
  ];
}

function checklistItemText(item: ChecklistItem): string {
  let checked = "x";
  if (item.status === "pending") {
    checked = " ";
  }
  if (item.status === "applied") {
    return `- [${checked}] \`${item.file}:${item.lineNumber}\` (removed)`;
  }
  if (item.status === "dismissed") {
    return `- [${checked}] \`${item.file}:${item.lineNumber}\` — \`${item.comment}\` (kept: "${item.label}")`;
  }
  return `- [${checked}] \`${item.file}:${item.lineNumber}\` — \`${item.comment}\``;
}

function checklistMarkdown(items: ChecklistItem[]): string {
  return items.map((item) => checklistItemText(item)).join("\n");
}

export default function* CommentReviewState({
  pr,
  data,
  classificationResult,
  sampleResult,
}: CommentReviewStateProps): Operation<CommentReviewStateValue> {
  const dismissedReplies = dismissedRepliesFor(data, classificationResult);
  const dismissedSet = dismissedSetFor(dismissedReplies);
  const appliedFindings = appliedFindingsFor(data, pr, dismissedSet);
  const pendingFindings = pendingFindingsFor(data, sampleResult, dismissedSet);
  const checklistItems = checklistItemsFor(appliedFindings, dismissedReplies, pendingFindings);

  return {
    hasChecklist: checklistItems.length > 0,
    checklistMd: checklistMarkdown(checklistItems),
    hasFindings: pendingFindings.length > 0,
    pendingFindings,
    newDismissReplies: dismissedReplies.filter((reply) => !reply.alreadyProcessed),
  };
}
