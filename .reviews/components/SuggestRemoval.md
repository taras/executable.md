---
inputs:
  findings:
    type: array
    required: true
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
