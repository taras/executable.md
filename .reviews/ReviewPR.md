---
title: PR Review
---

```ts eval
const BASE_SHA = process.env.BASE_SHA ?? "HEAD~1";
const HEAD_SHA = process.env.HEAD_SHA ?? "HEAD";
const PR_NUMBER = process.env.PR_NUMBER ?? "";
const PR_TITLE = process.env.PR_TITLE ?? "";
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY ?? "";
```

<Capture as="rawDiff">

```bash exec
git diff {BASE_SHA}...{HEAD_SHA}
```

</Capture>

<Capture as="rawFiles">

```bash exec
git diff --name-status {BASE_SHA}...{HEAD_SHA}
```

</Capture>

<Capture as="prBody">

```bash exec
gh api repos/{GITHUB_REPOSITORY}/pulls/{PR_NUMBER} --jq '.body' 2>/dev/null || echo ""
```

</Capture>

```ts eval
import { parseDiff } from "@executablemd/code-review-agent";

const pr = parseDiff(rawDiff, rawFiles, {
  title: PR_TITLE,
  body: prBody.trim(),
  number: PR_NUMBER,
});
```

<ThinkFilter>
<DeepInfraProvider model="Qwen/Qwen3-30B-A3B">
  <Instruction system="You are a precise TypeScript code review assistant for the executable-markdown-agents monorepo. Be concise. Report only findings, not praise.">
    <GitHubComment>
      <Format>
        <ReviewBody pr={pr} />
      </Format>
    </GitHubComment>
  </Instruction>
</DeepInfraProvider>
</ThinkFilter>
