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

```bash silent exec
mkdir -p .reviews
cat > .reviews/tsconfig.oxlint.json << 'TSCONFIG'
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "lib": ["ESNext", "DOM"],
    "types": []
  },
  "include": ["packages/*/src/**/*.ts", "packages/*/*.ts"],
  "exclude": ["node_modules", "dist", ".vendor", "**/*.test.ts"]
}
TSCONFIG
```

<Capture as="doctorJson">

<Doctor pr={pr} />

</Capture>

```ts eval
import { parseDoctorResult, parseDiagnostics } from "@executablemd/code-review-agent";

const doctor = parseDoctorResult(doctorJson);
```

<Capture as="rawDiagnostics">

<Show when={doctor.recommendation === "type-aware"
         || doctor.recommendation === "type-aware-filtered"}>

```bash exec
npx oxlint --type-aware --tsconfig .reviews/tsconfig.oxlint.json --format json 2>&1 || true
```

</Show>

<Show when={doctor.recommendation === "syntax-only"
         && doctor.oxlintInstalled}>

```bash exec
npx oxlint --format json 2>&1 || true
```

</Show>

<Show when={!doctor.oxlintInstalled}
  fallback="[]">
</Show>

</Capture>

```ts eval
const diagnostics = parseDiagnostics(rawDiagnostics, pr, doctor);
```

<ThinkFilter>
<DeepInfraProvider model="Qwen/Qwen3-30B-A3B">
  <Instruction system="You are a precise TypeScript code review assistant for the executable-markdown-agents monorepo. Be concise. Report only findings, not praise.">
    <GitHubComment>
      <Format>
        <ReviewBody pr={pr} diagnostics={diagnostics} doctor={doctor} />
      </Format>
    </GitHubComment>
  </Instruction>
</DeepInfraProvider>
</ThinkFilter>
