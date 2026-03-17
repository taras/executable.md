---
title: PR Review (local)
---

```ts eval
const BASE_SHA = process.env.BASE_SHA ?? "HEAD~1";
const HEAD_SHA = process.env.HEAD_SHA ?? "HEAD";
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

```ts eval
import { parseDiff } from "@executablemd/code-review-agent";

const pr = parseDiff(rawDiff, rawFiles, {
  title: process.env.PR_TITLE ?? "",
  body: process.env.PR_BODY ?? "",
  number: process.env.PR_NUMBER ?? "",
});
```

<OllamaProvider model="qwen3:30b-a3b">
  <Instruction system="You are a precise TypeScript code review assistant. Be concise. Report only findings, not praise.">
    <ReviewBody pr={pr} />
  </Instruction>
</OllamaProvider>
