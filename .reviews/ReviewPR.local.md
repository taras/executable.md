---
title: PR Review (local)
---

```ts eval
const BASE_SHA = process.env.BASE_SHA ?? "HEAD~1";
const HEAD_SHA = process.env.HEAD_SHA ?? "HEAD";
const PR_TITLE = process.env.PR_TITLE ?? "";
const PR_BODY = process.env.PR_BODY ?? "";
const PR_NUMBER = process.env.PR_NUMBER ?? "";
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
  title: PR_TITLE,
  body: PR_BODY,
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
  "include": [
    "packages/*/src/**/*.ts",
    "packages/*/*.ts",
    "core/src/**/*.ts",
    "cli/src/**/*.ts",
    "durable-streams/**/*.ts",
    "durable-effects/**/*.ts"
  ],
  "exclude": ["node_modules", "dist", ".vendor", "**/*.test.ts"]
}
TSCONFIG
```

```bash silent exec
ollama show qwen3:30b-a3b >/dev/null 2>&1 || ollama pull qwen3:30b-a3b
```

<Capture as="doctorJson" select="code[lang=json]">

<Doctor pr={pr} />

</Capture>

```ts eval
import { parseDoctorResult } from "@executablemd/code-review-agent";

const doctor = parseDoctorResult(doctorJson);
```

<Capture as="changedTsFiles">

```bash silent exec
git diff --name-only {BASE_SHA}...{HEAD_SHA} -- '*.ts' '*.tsx' | grep -v '\.test\.' | grep -v '\.spec\.' | grep -v '\.d\.ts$' | head -200
```

</Capture>

<Capture as="rawDiagnostics">

<Show when={doctor.recommendation === "type-aware"
         || doctor.recommendation === "type-aware-filtered"}>

```bash exec
if [ -n "{changedTsFiles}" ]; then
  echo "{changedTsFiles}" | tr '\n' ' ' | OXLINT_TSGOLINT_PATH=.reviews/.oxlint/tsgolint xargs .reviews/.oxlint/oxlint --config .reviews/.oxlintrc.json --type-aware --tsconfig .reviews/tsconfig.oxlint.json --format json 2>/dev/null || true
else
  echo "[]"
fi
```

</Show>

<Show when={doctor.recommendation === "syntax-only"
         && doctor.oxlintInstalled}>

```bash exec
if [ -n "{changedTsFiles}" ]; then
  echo "{changedTsFiles}" | tr '\n' ' ' | xargs .reviews/.oxlint/oxlint --config .reviews/.oxlintrc.json --format json 2>/dev/null || true
else
  echo "[]"
fi
```

</Show>

<Show when={!doctor.oxlintInstalled}>

[]

</Show>

</Capture>

```ts eval
import { parseDiagnostics } from "@executablemd/code-review-agent";

const diagnostics = parseDiagnostics(rawDiagnostics, pr, doctor);
```

<ThinkFilter>
<OllamaProvider model="qwen3:30b-a3b">
  <Instruction system="You are a precise TypeScript code review assistant. Be concise. Report only findings, not praise.">
    <PrPolicyReport pr={pr} diagnostics={diagnostics} doctor={doctor} />
  </Instruction>
</OllamaProvider>
</ThinkFilter>
