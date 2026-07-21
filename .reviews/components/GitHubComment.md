---
inputs:
  type: object
  properties:
    marker:
      type: string
      default: "<!-- xmd-review -->"
  additionalProperties: false
---

```ts eval
// GITHUB_TOKEN is read inline at each call site, never assigned to a binding:
// eval bindings are journaled, and the journal is uploaded as a CI artifact.
const content = yield* renderChildren();
const body = marker + "\n" + content.trim();

const repo = process.env.GITHUB_REPOSITORY;
const prNumber = process.env.PR_NUMBER;
const [owner, name] = repo.split("/");
const api = `https://api.github.com/repos/${owner}/${name}`;

const commentsResult = yield* fetch(`${api}/issues/${prNumber}/comments`, {
  headers: {
    "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
    "Accept": "application/vnd.github+json",
  },
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
      "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  }).expect();
} else {
  yield* fetch(`${api}/issues/${prNumber}/comments`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  }).expect();
}

return content;
```
