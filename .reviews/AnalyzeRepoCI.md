---
title: Repository Analysis (CI)
---

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
  "include": ["packages/*/src/**/*.ts", "packages/*/*.ts", "durable-effects/**/*.ts"],
  "exclude": ["node_modules", "dist", ".vendor", "**/*.test.ts"]
}
TSCONFIG
```

<Capture as="repoStats">

```bash exec
find durable-effects packages -name '*.ts' -not -name '*.test.ts' -not -name '*.spec.ts' -not -path '*/node_modules/*' 2>/dev/null | tee /tmp/xmd-repo-files.txt | wc -l | tr -d ' '
```

</Capture>

<Capture as="repoLineCount">

```bash exec
cat /tmp/xmd-repo-files.txt | xargs wc -l 2>/dev/null | tail -1 | awk '{print $1}'
```

</Capture>

<Capture as="fileList">

```bash exec
cat /tmp/xmd-repo-files.txt
```

</Capture>

```ts eval
const fileCount = parseInt(repoStats.trim(), 10) || 0;
const lineCount = parseInt(repoLineCount.trim(), 10) || 0;

const pr = {
  files: [], added: [], removed: [], created: [], modified: [], deleted: [],
  directories: new Set(),
  addedSource: "", diffPreview: "",
  stats: { totalFiles: fileCount, additions: lineCount, deletions: 0, totalChanges: lineCount },
  meta: { title: "Repo Analysis", body: "", number: "" },
};
```

<Capture as="doctorJson" select="code[lang=json]">

<Doctor pr={pr} />

</Capture>

```ts eval
import { parseDoctorResult } from "@executablemd/code-review-agent";

const doctor = parseDoctorResult(doctorJson);
```

<Capture as="rawDiagnostics">

<Show when={doctor.recommendation === "type-aware"
         || doctor.recommendation === "type-aware-filtered"}>

```bash exec
OUT=$(OXLINT_TSGOLINT_PATH=.reviews/.oxlint/tsgolint .reviews/.oxlint/oxlint --config .reviews/.oxlintrc.json --type-aware --tsconfig .reviews/tsconfig.oxlint.json --format json 2>/dev/null || true)
if [ -n "$OUT" ]; then
  printf '%s' "$OUT"
else
  echo "[]"
fi
```

</Show>

<Show when={doctor.recommendation === "syntax-only"
         && doctor.oxlintInstalled}>

```bash exec
OUT=$(.reviews/.oxlint/oxlint --config .reviews/.oxlintrc.json --format json 2>/dev/null || true)
if [ -n "$OUT" ]; then
  printf '%s' "$OUT"
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
import {
  buildCleanupAnalysis,
  parseDiagnostics,
} from "@executablemd/code-review-agent";

const diagnostics = parseDiagnostics(rawDiagnostics, pr, doctor);
const cleanupAnalysis = buildCleanupAnalysis(diagnostics);
```

<ThinkFilter>
<DeepInfraProvider model="Qwen/Qwen3-30B-A3B">
  <Instruction system="You are a precise TypeScript code health analyst. Be concise. Report only findings, not praise. Focus on actionable cleanup opportunities.">
    <RepoPolicyReport diagnostics={diagnostics} doctor={doctor} fileList={fileList} fileCount={fileCount} lineCount={lineCount} cleanupAnalysis={cleanupAnalysis} />
  </Instruction>
</DeepInfraProvider>
</ThinkFilter>
