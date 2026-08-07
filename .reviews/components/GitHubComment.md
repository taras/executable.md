---
props:
  type: object
  properties:
    marker:
      type: string
      default: "<!-- xmd-review -->"
  additionalProperties: false
---

```ts eval
const content = yield* renderChildren();
const body = marker + "\n" + content.trim();

const repo = process.env.GITHUB_REPOSITORY;
const prNumber = process.env.PR_NUMBER;
const [owner, name] = repo.split("/");
const api = `https://api.github.com/repos/${owner}/${name}`;

function githubHeaders() {
  return {
    "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
    "Accept": "application/vnd.github+json",
  };
}

const commentsResult = yield* fetch(`${api}/issues/${prNumber}/comments`, {
  headers: githubHeaders(),
})
  .expect()
  .json();

const existing = commentsResult.find(c =>
  c.user.type === "Bot" && c.body.includes(marker)
);

if (existing) {
  yield* fetch(`${api}/issues/comments/${existing.id}`, {
    method: "PATCH",
    headers: {
      ...githubHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  }).expect();
} else {
  yield* fetch(`${api}/issues/${prNumber}/comments`, {
    method: "POST",
    headers: {
      ...githubHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  }).expect();
}

return content;
```
