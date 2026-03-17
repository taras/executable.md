---
inputs:
  findings:
    type: array
    required: true
  dismissedReplies:
    type: array
    required: false
    default: []
---

```ts eval
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const prNumber = process.env.PR_NUMBER;
const headSha = process.env.HEAD_SHA;

if (!token || !repo || !prNumber || !headSha || findings.length === 0) {
  return "";
}

const [owner, name] = repo.split("/");
const api = `https://api.github.com/repos/${owner}/${name}`;

const headers = {
  "Authorization": `Bearer ${token}`,
  "Accept": "application/vnd.github+json",
  "Content-Type": "application/json",
};

// 1. Delete old bot reviews to avoid duplicates
const existingReviews = yield* fetch(
  `${api}/pulls/${prNumber}/reviews`, { headers }
).expect().json();

const botReviews = existingReviews.filter(r =>
  r.user.login === "github-actions[bot]" &&
  r.body && r.body.includes("redundant comment")
);

for (const review of botReviews) {
  try {
    yield* fetch(`${api}/pulls/${prNumber}/reviews/${review.id}`, {
      method: "DELETE",
      headers,
    }).expect();
  } catch {
    // Review may already be submitted (can't delete submitted reviews).
    // That's fine — the new review will be posted alongside.
  }
}

// 2. React 👍 on dismiss replies that haven't been reacted to yet
for (const reply of dismissedReplies) {
  if (!reply.replyId) continue;
  try {
    yield* fetch(`${api}/pulls/comments/${reply.replyId}/reactions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "+1" }),
    }).expect();
  } catch {
    // Reaction may already exist — that's fine.
  }
}

// 3. Post new review with pending findings
const comments = findings.map(f => ({
  path: f.file,
  line: f.lineNumber,
  body: `Redundant comment — restates what the code does.\n\`\`\`suggestion\n\`\`\``,
}));

yield* fetch(`${api}/pulls/${prNumber}/reviews`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    commit_id: headSha,
    event: "COMMENT",
    body: `Found ${findings.length} redundant comment${findings.length === 1 ? "" : "s"}. Inline suggestions to remove them below.`,
    comments,
  }),
}).expect();

return "";
```
