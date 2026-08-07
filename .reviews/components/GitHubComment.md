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
import { env as runtimeEnv, fetch as runtimeFetch } from "@executablemd/runtime";

const content = yield* renderChildren();
const body = marker + "\n" + content.trim();

function* postComment() {
  const repo = yield* runtimeEnv("GITHUB_REPOSITORY");
  const prNumber = yield* runtimeEnv("PR_NUMBER");
  if (!repo || !prNumber) {
    return content;
  }

  const api = `https://api.github.com/repos/${repo}`;
  function* request(path, options = {}) {
    const response = yield* runtimeFetch(`${api}${path}`, {
      ...options,
      headers: options.headers,
    });
    const result = yield* response.text();
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`GitHub comment request failed (${response.status})`);
    }
    return result ? JSON.parse(result) : {};
  }

  const commentsResult = yield* request(`/issues/${prNumber}/comments`);
  const existing = commentsResult.find((comment) =>
    comment.user.type === "Bot" && comment.body.includes(marker)
  );
  if (existing) {
    yield* request(`/issues/comments/${existing.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
  } else {
    yield* request(`/issues/${prNumber}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
  }
  return content;
}

return yield* postComment();
```
