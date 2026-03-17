---
inputs:
  marker: "<!-- ema-review -->"
---

```ts eval
const content = yield* renderChildren();
const body = marker + "\n" + content;

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const prNumber = process.env.PR_NUMBER;
const [owner, name] = repo.split("/");
const api = `https://api.github.com/repos/${owner}/${name}`;

const headers = {
  "Authorization": `Bearer ${token}`,
  "Accept": "application/vnd.github+json",
};

const commentsResult = yield* fetch(
  `${api}/issues/${prNumber}/comments`, { headers }
)
  .expect()
  .json();

const existing = commentsResult.find(c =>
  c.user.type === "Bot" && c.body.includes(marker)
);

if (existing) {
  yield* fetch(`${api}/issues/comments/${existing.id}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  }).expect();
} else {
  yield* fetch(`${api}/issues/${prNumber}/comments`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  }).expect();
}

return content;
```
