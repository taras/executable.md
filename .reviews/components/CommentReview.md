---
props:
  type: object
  properties:
    pr:
      type: object
  required: [pr]
  additionalProperties: false
---

```ts eval
// ---------------------------------------------------------------------------
// 1. Build comment/code pairs with file/line metadata
const pairs = [];
const lines = pr.added.filter(l => !l.isTest);

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

const hasPairs = pairs.length >= 3;
const pairsText = hasPairs
  ? pairs.map((p, i) =>
      `[${i}] COMMENT: ${p.comment}\nCODE: ${p.code}`
    ).join("\n---\n")
  : "";

let hasChecklist = false;
let checklistMd = "";

// ---------------------------------------------------------------------------
// 2. Fetch previous bot review comments and human replies
import { env as runtimeEnv, fetch as runtimeFetch } from "@executablemd/runtime";

function* loadReviewHistory() {
  const repo = yield* runtimeEnv("GITHUB_REPOSITORY");
  const prNumber = yield* runtimeEnv("PR_NUMBER");
  if (!repo || !prNumber) {
    return { previousFindings: [], dismissedReplies: [], repliesForClassification: [] };
  }

  const api = `https://api.github.com/repos/${repo}`;
  function* json(path) {
    const response = yield* runtimeFetch(`${api}${path}`);
    const body = yield* response.text();
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`GitHub review history request failed (${response.status})`);
    }
    return JSON.parse(body);
  }

  const allComments = yield* json(`/pulls/${prNumber}/comments?per_page=100`);
  const botComments = allComments.filter((comment) =>
    comment.user.login === "github-actions[bot]" &&
    comment.body && comment.body.includes("Redundant comment")
  );
  const botCommentMap = new Map();
  for (const comment of botComments) {
    const hunkLines = (comment.diff_hunk ?? "").split("\n");
    const commentLine = hunkLines.filter((line) => line.startsWith("+")).pop() ?? "";
    botCommentMap.set(comment.id, {
      file: comment.path,
      lineNumber: comment.original_line ?? comment.line,
      comment: commentLine.replace(/^\+\s*/, "").trim(),
    });
  }

  const dismissedReplies = [];
  const repliesForClassification = [];
  const humanReplies = allComments.filter((comment) =>
    comment.in_reply_to_id && botCommentMap.has(comment.in_reply_to_id) &&
    comment.user.type !== "Bot"
  );
  for (const reply of humanReplies) {
    const location = botCommentMap.get(reply.in_reply_to_id);
    const entry = {
      ...location,
      botCommentId: reply.in_reply_to_id,
      replyText: reply.body,
      replyId: reply.id,
    };
    try {
      const reactions = yield* json(`/pulls/comments/${reply.id}/reactions`);
      const alreadyAcked = reactions.some((reaction) =>
        reaction.user.login === "github-actions[bot]" && reaction.content === "+1"
      );
      if (alreadyAcked) {
        dismissedReplies.push({ ...entry, alreadyProcessed: true });
      } else {
        repliesForClassification.push(entry);
      }
    } catch {
      repliesForClassification.push(entry);
    }
  }

  return {
    previousFindings: botComments.map((comment) => ({
      file: comment.path,
      lineNumber: comment.original_line ?? comment.line,
    })),
    dismissedReplies,
    repliesForClassification,
  };
}

const history = yield* loadReviewHistory();
let previousFindings = history.previousFindings;
let dismissedReplies = history.dismissedReplies;
const repliesForClassification = history.repliesForClassification;

const hasRepliesToClassify = repliesForClassification.length > 0;
const repliesText = hasRepliesToClassify
  ? repliesForClassification.map((r, i) =>
      `[${i}] FILE: ${r.file}:${r.lineNumber}\nREPLY: "${r.replyText}"`
    ).join("\n---\n")
  : "";
```

<Show when={hasRepliesToClassify}>

<Capture as="classificationResult">

<Sample>

For each reply to an automated code review suggestion, classify the
user's intent. They are replying to a suggestion to remove a redundant
code comment.

DISMISS — the user wants to keep the comment (any reason)
ACCEPT — the user agrees the comment should be removed

Format: [index] DISMISS or [index] ACCEPT

{repliesText}

</Sample>

</Capture>

```ts eval
const classPattern = /\[(\d+)\]\s*(DISMISS|ACCEPT)/gi;
let cm;
while ((cm = classPattern.exec(classificationResult)) !== null) {
  const idx = parseInt(cm[1], 10);
  const intent = cm[2].toUpperCase();
  if (idx >= 0 && idx < repliesForClassification.length && intent === "DISMISS") {
    dismissedReplies.push(repliesForClassification[idx]);
  }
}
```

</Show>

```ts eval
// ---------------------------------------------------------------------------
// 3. Build dismissed set and detect applied suggestions
// ---------------------------------------------------------------------------

const dismissedSet = new Set(
  dismissedReplies.map(d => `${d.file}:${d.lineNumber}`)
);

const addedLineSet = new Set(
  pr.added.map(l => `${l.file}:${l.lineNumber}`)
);
const appliedFindings = previousFindings.filter(pf =>
  pf.lineNumber && !addedLineSet.has(`${pf.file}:${pf.lineNumber}`) &&
  !dismissedSet.has(`${pf.file}:${pf.lineNumber}`)
);
const appliedSet = new Set(
  appliedFindings.map(af => `${af.file}:${af.lineNumber}`)
);

const hasHistory = previousFindings.length > 0;
```

<Show when={hasPairs}>

<Capture as="sampleResult">

<Sample>

Review these comment/code pairs. List ONLY obvious/redundant ones
where the comment restates what the code does.

Format each finding as: REDUNDANT[index]: comment text

If none are obvious: "No obvious comments found."

{pairsText}

</Sample>

</Capture>

```ts eval
const redundantIndices = [];
const indexPattern = /REDUNDANT\[(\d+)\]/g;
let m;
while ((m = indexPattern.exec(sampleResult)) !== null) {
  const idx = parseInt(m[1], 10);
  if (idx >= 0 && idx < pairs.length) redundantIndices.push(idx);
}

const allFindings = redundantIndices.map(i => pairs[i]);
const pendingFindings = allFindings.filter(f =>
  !dismissedSet.has(`${f.file}:${f.lineNumber}`)
);
const hasFindings = pendingFindings.length > 0;

const checklistItems = [];

for (const af of appliedFindings) {
  checklistItems.push({
    status: "applied",
    file: af.file,
    lineNumber: af.lineNumber,
    label: "removed",
  });
}

for (const df of dismissedReplies) {
  checklistItems.push({
    status: "dismissed",
    file: df.file,
    lineNumber: df.lineNumber,
    comment: df.comment ?? "",
    label: df.replyText,
  });
}

for (const pf of pendingFindings) {
  checklistItems.push({
    status: "pending",
    file: pf.file,
    lineNumber: pf.lineNumber,
    comment: pf.comment,
  });
}

// Redeclared, not reassigned: bindings from earlier eval blocks arrive in
// later blocks as consts, so assignment throws. A fresh declaration shadows
// the injected binding and its export overrides env for the <Show> below.
const hasChecklist = checklistItems.length > 0;
const checklistMd = checklistItems.map(item => {
  const checked = item.status !== "pending" ? "x" : " ";
  if (item.status === "applied") {
    return `- [${checked}] \`${item.file}:${item.lineNumber}\` (removed)`;
  }
  if (item.status === "dismissed") {
    return `- [${checked}] \`${item.file}:${item.lineNumber}\` — \`${item.comment}\` (kept: "${item.label}")`;
  }
  return `- [${checked}] \`${item.file}:${item.lineNumber}\` — \`${item.comment}\``;
}).join("\n");

const newDismissReplies = dismissedReplies.filter(d => !d.alreadyProcessed);
```

<Show when={hasFindings}>

<SuggestRemoval findings={pendingFindings} dismissedReplies={newDismissReplies} />

</Show>

</Show>

<Show when={hasChecklist}>

{checklistMd}

</Show>
