---
inputs:
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
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const prNumber = process.env.PR_NUMBER;
const headSha = process.env.HEAD_SHA;

if (!token || !repo || !prNumber || !headSha) {
  return "";
}

const [owner, name] = repo.split("/");
const api = `https://api.github.com/repos/${owner}/${name}`;
const graphql = "https://api.github.com/graphql";

const headers = {
  "Authorization": `Bearer ${token}`,
  "Accept": "application/vnd.github+json",
  "Content-Type": "application/json",
};

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
  }
}

// 2. React 👍 on dismiss replies and resolve their threads
if (dismissedReplies.length > 0) {
  // Fetch review threads via GraphQL to get thread node IDs
  const threadsQuery = `query($owner: String!, $name: String!, $pr: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            comments(first: 1) {
              nodes { databaseId }
            }
          }
        }
      }
    }
  }`;

  let threadMap = new Map();
  try {
    const threadsResult = yield* fetch(graphql, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: threadsQuery,
        variables: { owner, name, pr: parseInt(prNumber, 10) },
      }),
    }).expect().json();

    const threads = threadsResult.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    for (const thread of threads) {
      const commentId = thread.comments?.nodes?.[0]?.databaseId;
      if (commentId) {
        threadMap.set(commentId, { threadId: thread.id, isResolved: thread.isResolved });
      }
    }
  } catch {
    // If GraphQL fails, skip thread resolution — 👍 reaction still works
  }

  for (const reply of dismissedReplies) {
    // React 👍
    if (reply.replyId) {
      try {
        yield* fetch(`${api}/pulls/comments/${reply.replyId}/reactions`, {
          method: "POST",
          headers,
          body: JSON.stringify({ content: "+1" }),
        }).expect();
      } catch {}
    }

    // Resolve the thread
    if (reply.botCommentId && threadMap.has(reply.botCommentId)) {
      const { threadId, isResolved } = threadMap.get(reply.botCommentId);
      if (!isResolved) {
        try {
          yield* fetch(graphql, {
            method: "POST",
            headers,
            body: JSON.stringify({
              query: `mutation($threadId: ID!) {
                resolveReviewThread(input: { threadId: $threadId }) {
                  thread { isResolved }
                }
              }`,
              variables: { threadId },
            }),
          }).expect();
        } catch {}
      }
    }
  }
}

// 3. Post new review with pending findings
if (findings.length > 0) {
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
}

return "";
```
