---
title: Repository Analysis
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
  "include": ["packages/*/src/**/*.ts", "packages/*/*.ts", "core/src/**/*.ts", "cli/src/**/*.ts", "durable-streams/**/*.ts", "durable-effects/**/*.ts"],
  "exclude": ["node_modules", "dist", ".vendor", "**/*.test.ts"]
}
TSCONFIG
```

<Capture as="repoStats">

```bash exec
find core/src cli/src durable-streams durable-effects packages -name '*.ts' -not -name '*.test.ts' -not -name '*.spec.ts' -not -path '*/node_modules/*' 2>/dev/null | tee /tmp/ema-repo-files.txt | wc -l | tr -d ' '
```

</Capture>

<Capture as="repoLineCount">

```bash exec
cat /tmp/ema-repo-files.txt | xargs wc -l 2>/dev/null | tail -1 | awk '{print $1}'
```

</Capture>

<Capture as="fileList">

```bash exec
cat /tmp/ema-repo-files.txt
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

<Capture as="doctorJson">

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
import { parseDiagnostics } from "@executablemd/code-review-agent";

const diagnostics = parseDiagnostics(rawDiagnostics, pr, doctor);
```

<ThinkFilter>
<OllamaProvider model="qwen3:30b-a3b">
  <Instruction system="You are a precise TypeScript code health analyst. Be concise. Report only findings, not praise. Focus on actionable cleanup opportunities.">
    <RepoBody diagnostics={diagnostics} doctor={doctor} fileList={fileList} fileCount={fileCount} lineCount={lineCount} />
  </Instruction>
</OllamaProvider>
</ThinkFilter>
