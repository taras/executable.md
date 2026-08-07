---
title: Repository Analysis (CI)
---

<Output>

<GitHubAuth>
<ReviewSetup />

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
<DeepInfraProvider model="Qwen/Qwen3-30B-A3B">
  <Instruction system="You are a precise TypeScript code health analyst. Be concise. Report only findings, not praise. Focus on actionable cleanup opportunities.">
    <RepoPolicyReport diagnostics={diagnostics} doctor={doctor} fileList={fileList} fileCount={fileCount} lineCount={lineCount} cleanupAnalysis={cleanupAnalysis} />
  </Instruction>
</DeepInfraProvider>
</ThinkFilter>

</GitHubAuth>
</Output>
