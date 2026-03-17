---
inputs:
  pr:
    type: object
    required: true
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

// ---------------------------------------------------------------------------
// 2. Fetch previous bot review comments and human replies
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const prNumber = process.env.PR_NUMBER;

let previousFindings = [];
let dismissedReplies = [];
let repliesForClassification = [];

if (token && repo && prNumber) {
  const [owner, name] = repo.split("/");
  const api = `https://api.github.com/repos/${owner}/${name}`;
  const headers = {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
  };

  const allComments = yield* fetch(
    `${api}/pulls/${prNumber}/comments?per_page=100`, { headers }
  ).expect().json();

  const botComments = allComments.filter(c =>
    c.user.login === "github-actions[bot]" &&
    c.body && c.body.includes("Redundant comment")
  );

  // Build map of bot comment id → { file, line, comment }
  const botCommentMap = new Map();
  for (const bc of botComments) {
    // Extract the comment text from the diff hunk (last + line with //)
    const hunkLines = (bc.diff_hunk ?? "").split("\n");
    const commentLine = hunkLines.filter(l => l.startsWith("+")).pop() ?? "";
    const commentText = commentLine.replace(/^\+\s*/, "").trim();
    botCommentMap.set(bc.id, {
      file: bc.path,
      lineNumber: bc.original_line ?? bc.line,
      comment: commentText,
    });
  }

  const humanReplies = allComments.filter(c =>
    c.in_reply_to_id && botCommentMap.has(c.in_reply_to_id) &&
    c.user.type !== "Bot"
  );

  // Check which replies already have a 👍 reaction (already processed)
  for (const reply of humanReplies) {
    const location = botCommentMap.get(reply.in_reply_to_id);
    const entry = {
      ...location,
      botCommentId: reply.in_reply_to_id,
      replyText: reply.body,
      replyId: reply.id,
    };
    try {
      const reactions = yield* fetch(
        `${api}/pulls/comments/${reply.id}/reactions`, { headers }
      ).expect().json();
      const alreadyAcked = reactions.some(r =>
        r.user.login === "github-actions[bot]" && r.content === "+1"
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

  previousFindings = botComments.map(bc => ({
    file: bc.path,
    lineNumber: bc.original_line ?? bc.line,
  }));
}

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
