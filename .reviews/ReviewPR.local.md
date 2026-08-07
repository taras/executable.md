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

// TODO: we need an easier way to work with diffs here.
const changedFilePaths = pr.files.map((file) => file.path);
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
changed_files=$(cat <<'FILES'
{changedTsFiles}
FILES
)
if [ -z "$changed_files" ]; then
  printf '[]'
else
  raw=$(printf '%s\n' "$changed_files" | OXLINT_TSGOLINT_PATH=.reviews/.oxlint/tsgolint xargs .reviews/.oxlint/oxlint --config .reviews/.oxlintrc.json --type-aware --tsconfig .reviews/tsconfig.oxlint.json --format json 2>/dev/null || true)
  if [ -z "$raw" ] || ! printf '%s' "$raw" | jq -c --arg changed "$changed_files" '
    def entries:
      if type == "array" then .
      elif (.diagnostics? | type) == "array" then .diagnostics
      else []
      end;
    def span_line:
      if (.line? | type) == "number" then .line
      elif (.labels?[0].span.line? | type) == "number" then .labels[0].span.line
      else 0
      end;
    def span_column:
      if (.column? | type) == "number" then .column
      elif (.labels?[0].span.column? | type) == "number" then .labels[0].span.column
      else 0
      end;
    entries
    | map({
        message: (if (.message? | type) == "string" then .message else "" end),
        ruleId: (if (.ruleId? | type) == "string" then .ruleId elif (.code? | type) == "string" then .code else "unknown" end),
        severity: (if .severity == "error" then "error" else "warning" end),
        file: (if (.file? | type) == "string" then .file elif (.filename? | type) == "string" then .filename else "" end),
        line: span_line,
        column: span_column
      })
    | map(select(.file as $file | ($changed | split("\n") | index($file)) != null))
  '; then
    printf '[]'
  fi
fi
```

</Show>

<Show when={doctor.recommendation === "syntax-only"
         && doctor.oxlintInstalled}>

```bash exec
changed_files=$(cat <<'FILES'
{changedTsFiles}
FILES
)
if [ -z "$changed_files" ]; then
  printf '[]'
else
  raw=$(printf '%s\n' "$changed_files" | xargs .reviews/.oxlint/oxlint --config .reviews/.oxlintrc.json --format json 2>/dev/null || true)
  if [ -z "$raw" ] || ! printf '%s' "$raw" | jq -c --arg changed "$changed_files" '
    def entries:
      if type == "array" then .
      elif (.diagnostics? | type) == "array" then .diagnostics
      else []
      end;
    def span_line:
      if (.line? | type) == "number" then .line
      elif (.labels?[0].span.line? | type) == "number" then .labels[0].span.line
      else 0
      end;
    def span_column:
      if (.column? | type) == "number" then .column
      elif (.labels?[0].span.column? | type) == "number" then .labels[0].span.column
      else 0
      end;
    entries
    | map({
        message: (if (.message? | type) == "string" then .message else "" end),
        ruleId: (if (.ruleId? | type) == "string" then .ruleId elif (.code? | type) == "string" then .code else "unknown" end),
        severity: (if .severity == "error" then "error" else "warning" end),
        file: (if (.file? | type) == "string" then .file elif (.filename? | type) == "string" then .filename else "" end),
        line: span_line,
        column: span_column
      })
    | map(select(.file as $file | ($changed | split("\n") | index($file)) != null))
  '; then
    printf '[]'
  fi
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

<ReleaseSpecWarning files={changedFilePaths} />

<ThinkFilter>
<OllamaProvider model="qwen3:30b-a3b">
  <Instruction system="You are a precise TypeScript code review assistant. Be concise. Report only findings, not praise.">
    <PrPolicyReport pr={pr} diagnostics={diagnostics} doctor={doctor} />
  </Instruction>
</OllamaProvider>
</ThinkFilter>
