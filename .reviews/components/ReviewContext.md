---
returns:
  type: object
  properties:
    pr:
      type: object
    changedFilePaths:
      type: array
      items:
        type: string
  required: [pr, changedFilePaths]
  additionalProperties: false
---

```ts eval
import { env as runtimeEnv, exec, fetch as runtimeFetch } from "@executablemd/runtime";
import { parseDiff } from "@executablemd/code-review-agent";

function* pullBody(repository, number, fallback) {
  if (fallback || !repository || !number) {
    return fallback;
  }

  const response = yield* runtimeFetch(
    `https://api.github.com/repos/${repository}/pulls/${number}`,
  );
  const body = yield* response.text();
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`GitHub pull request lookup failed (${response.status})`);
  }
  const payload = JSON.parse(body);
  return typeof payload.body === "string" ? payload.body : fallback;
}

function* collectReviewContext() {
  const base = (yield* runtimeEnv("BASE_SHA")) ?? "HEAD~1";
  const head = (yield* runtimeEnv("HEAD_SHA")) ?? "HEAD";
  const title = (yield* runtimeEnv("PR_TITLE")) ?? "";
  const number = (yield* runtimeEnv("PR_NUMBER")) ?? "";
  const repository = (yield* runtimeEnv("GITHUB_REPOSITORY")) ?? "";
  const localBody = (yield* runtimeEnv("PR_BODY")) ?? "";

  const range = `${base}...${head}`;
  const diff = yield* exec({ command: ["git", "diff", range] });
  if (diff.exitCode !== 0) {
    throw new Error(diff.stderr || `git diff failed with exit code ${diff.exitCode}`);
  }
  const names = yield* exec({ command: ["git", "diff", "--name-status", range] });
  if (names.exitCode !== 0) {
    throw new Error(names.stderr || `git diff --name-status failed with exit code ${names.exitCode}`);
  }

  const body = yield* pullBody(repository, number, localBody);
  const parsed = parseDiff(diff.stdout, names.stdout, { title, body, number });
  const pr = { ...parsed, addedSource: parsed.diffPreview };

  return {
    pr,
    changedFilePaths: pr.files.map((file) => file.path),
  };
}

const context = yield* collectReviewContext();
```

<Return value={context} />
