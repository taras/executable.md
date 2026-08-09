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
import { env as runtimeEnv } from "@executablemd/runtime";

function* reviewConfiguration() {
  const repository = yield* runtimeEnv("GITHUB_REPOSITORY");
  const number = yield* runtimeEnv("PR_NUMBER");
  if (!repository || !number || !repository.includes("/")) {
    throw new Error("GitHubComment requires GITHUB_REPOSITORY and PR_NUMBER");
  }
  const [owner, name] = repository.split("/");
  return { api: `https://api.github.com/repos/${owner}/${name}`, number };
}

const content = yield* renderChildren();
const body = props.marker + "\n" + content.trim();
const { api, number } = yield* reviewConfiguration();
const comments = yield* fetch(`${api}/issues/${number}/comments`).expect().json();
if (!Array.isArray(comments)) {
  throw new Error("GitHub comments response was not an array");
}

const existing = comments.find((comment) =>
  comment.user?.type === "Bot" && typeof comment.body === "string" && comment.body.includes(props.marker)
);
if (existing) {
  yield* fetch(`${api}/issues/comments/${existing.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  }).expect();
} else {
  yield* fetch(`${api}/issues/${number}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  }).expect();
}

return content;
```
