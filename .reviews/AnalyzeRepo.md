---
title: Repository Analysis
---

<GitHubAuth>
<ReviewSetup pullModel={true} />

<RepositoryInventory as="inventory" />

```ts eval
const fileList = inventory.fileList;
const fileCount = inventory.fileCount;
const lineCount = inventory.lineCount;
const pr = {
  files: [],
  added: [],
  removed: [],
  created: [],
  modified: [],
  deleted: [],
  directories: [],
  addedSource: "",
  diffPreview: "",
  stats: { totalFiles: fileCount, additions: lineCount, deletions: 0, totalChanges: lineCount },
  meta: { title: "Repo Analysis", body: "", number: "" },
};
```

<Doctor as="doctor" />

<OxlintDiagnostics
  files={fileList}
  typeAware={doctor.recommendation !== "syntax-only"}
  as="rawDiagnostics"
 />

```ts eval
import {
  buildCleanupAnalysis,
  parseDiagnostics,
} from "@executablemd/code-review-agent";

const diagnostics = parseDiagnostics(rawDiagnostics, pr, doctor);
const cleanupAnalysis = buildCleanupAnalysis(diagnostics);
```

<ThinkFilter>
<OllamaProvider model="qwen3:30b-a3b">
  <Instruction system="You are a precise TypeScript code health analyst. Be concise. Report only findings, not praise. Focus on actionable cleanup opportunities.">
    <RepoPolicyReport diagnostics={diagnostics} doctor={doctor} fileList={fileList} fileCount={fileCount} lineCount={lineCount} cleanupAnalysis={cleanupAnalysis} />
  </Instruction>
</OllamaProvider>
</ThinkFilter>

</GitHubAuth>
