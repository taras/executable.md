---
title: PR Review (local)
---

<GitHubAuth>
<ReviewSetup pullModel={true} />

<ReviewContext as="context" />

<Doctor as="doctor" />

```ts eval
const pr = context.pr;
const changedFilePaths = context.changedFilePaths;
const changedTsFiles = pr.files
  .filter((file) => file.language === "typescript" && !file.isTest && !file.isTypeDeclaration)
  .map((file) => file.path)
  .slice(0, 200);
```

<OxlintDiagnostics
  files={changedTsFiles}
  typeAware={doctor.recommendation !== "syntax-only"}
  as="rawDiagnostics"
 />

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

</GitHubAuth>
