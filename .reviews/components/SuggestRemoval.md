---
props:
  type: object
  properties:
    findings:
      type: array
    dismissedReplies:
      type: array
      default: []
  required: [findings]
  additionalProperties: false
---

```ts eval
import { env as runtimeEnv, fetch as runtimeFetch } from "@executablemd/runtime";

function* run() {
  const repo = yield* runtimeEnv("GITHUB_REPOSITORY");
  const prNumber = yield* runtimeEnv("PR_NUMBER");
  const headSha = yield* runtimeEnv("HEAD_SHA");
  if (!repo || !prNumber || !headSha) {
    return "";
  }

  const api = `https://api.github.com/repos/${repo}`;
  const graphql = "https://api.github.com/graphql";
  function* request(url, options = {}) {
    const response = yield* runtimeFetch(url, {
      ...options,
      headers: options.headers,
    });
    const body = yield* response.text();
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`GitHub review update failed (${response.status})`);
    }
    return body ? JSON.parse(body) : {};
  }

  const existingReviews = yield* request(`${api}/pulls/${prNumber}/reviews`);
  const botReviews = existingReviews.filter((review) =>
    review.user.login === "github-actions[bot]" &&
    review.body && review.body.includes("redundant comment")
  );
  for (const review of botReviews) {
    try {
      yield* request(`${api}/pulls/${prNumber}/reviews/${review.id}`, { method: "DELETE" });
    } catch {
    }
  }

  if (dismissedReplies.length > 0) {
    const threadsQuery = `query($owner: String!, $name: String!, $pr: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $pr) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              comments(first: 1) { nodes { databaseId } }
            }
          }
        }
      }
    }`;
    const [owner, name] = repo.split("/");
    let threadMap = new Map();
    try {
      const threadsResult = yield* request(graphql, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: threadsQuery,
          variables: { owner, name, pr: parseInt(prNumber, 10) },
        }),
      });
      const threads = threadsResult.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
      for (const thread of threads) {
        const commentId = thread.comments?.nodes?.[0]?.databaseId;
        if (commentId) {
          threadMap.set(commentId, { threadId: thread.id, isResolved: thread.isResolved });
        }
      }
    } catch {
    }

    for (const reply of dismissedReplies) {
      if (reply.replyId) {
          try {
            yield* request(`${api}/pulls/comments/${reply.replyId}/reactions`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: "+1" }),
          });
        } catch {
        }
      }
      if (reply.botCommentId && threadMap.has(reply.botCommentId)) {
        const thread = threadMap.get(reply.botCommentId);
        if (!thread.isResolved) {
          try {
            yield* request(graphql, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                query: `mutation($threadId: ID!) {
                  resolveReviewThread(input: { threadId: $threadId }) {
                    thread { isResolved }
                  }
                }`,
                variables: { threadId: thread.threadId },
              }),
            });
          } catch {
          }
        }
      }
    }
  }

  if (findings.length > 0) {
    const comments = findings.map((finding) => ({
      path: finding.file,
      line: finding.lineNumber,
      body: "Redundant comment — restates what the code does.\n```suggestion\n```",
    }));
    yield* request(`${api}/pulls/${prNumber}/reviews`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commit_id: headSha,
        event: "COMMENT",
        body: `Found ${findings.length} redundant comment${findings.length === 1 ? "" : "s"}. Inline suggestions to remove them below.`,
        comments,
      }),
    });
  }
  return "";
}

return yield* run();
```
