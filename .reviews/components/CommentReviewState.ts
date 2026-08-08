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
  previousFindings: Array<{ file: string; lineNumber: number }>;
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

function key(file: string, lineNumber: number): string {
  return `${file}:${lineNumber}`;
}

export default function* CommentReviewState({
  pr,
  data,
  classificationResult,
  sampleResult,
}: CommentReviewStateProps): Operation<CommentReviewStateValue> {
  const dismissedReplies = [...data.dismissedReplies];
  const classificationPattern = /\[(\d+)\]\s*(DISMISS|ACCEPT)/gi;
  let classificationMatch: RegExpExecArray | null;
  while ((classificationMatch = classificationPattern.exec(classificationResult)) !== null) {
    const index = Number.parseInt(classificationMatch[1], 10);
    if (
      index >= 0 &&
      index < data.repliesForClassification.length &&
      classificationMatch[2].toUpperCase() === "DISMISS"
    ) {
      dismissedReplies.push(data.repliesForClassification[index]);
    }
  }

  const dismissedSet = new Set(dismissedReplies.map((reply) => key(reply.file, reply.lineNumber)));
  const addedLineSet = new Set(pr.added.map((line) => key(line.file, line.lineNumber)));
  const appliedFindings = data.previousFindings.filter(
    (finding) =>
      !addedLineSet.has(key(finding.file, finding.lineNumber)) &&
      !dismissedSet.has(key(finding.file, finding.lineNumber)),
  );
  const redundantIndices: number[] = [];
  const indexPattern = /REDUNDANT\[(\d+)\]/g;
  let sampleMatch: RegExpExecArray | null;
  while ((sampleMatch = indexPattern.exec(sampleResult)) !== null) {
    const index = Number.parseInt(sampleMatch[1], 10);
    if (index >= 0 && index < data.pairs.length) {
      redundantIndices.push(index);
    }
  }
  const pendingFindings = redundantIndices
    .map((index) => data.pairs[index])
    .filter((finding) => !dismissedSet.has(key(finding.file, finding.lineNumber)));

  const checklistItems: ChecklistItem[] = [
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
  const checklistMd = checklistItems
    .map((item) => {
      const checked = item.status !== "pending" ? "x" : " ";
      if (item.status === "applied") {
        return `- [${checked}] \`${item.file}:${item.lineNumber}\` (removed)`;
      }
      if (item.status === "dismissed") {
        return `- [${checked}] \`${item.file}:${item.lineNumber}\` — \`${item.comment}\` (kept: "${item.label}")`;
      }
      return `- [${checked}] \`${item.file}:${item.lineNumber}\` — \`${item.comment}\``;
    })
    .join("\n");

  return {
    hasChecklist: checklistItems.length > 0,
    checklistMd,
    hasFindings: pendingFindings.length > 0,
    pendingFindings,
    newDismissReplies: dismissedReplies.filter((reply) => !reply.alreadyProcessed),
  };
}
