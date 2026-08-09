---
title: PR Review
---

<Output>

<GitHubAuth>
<ReviewSetup />

<ReviewContext as="context" />
<Doctor pr={context.pr} as="doctor" />

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
import { buildDiagnostics } from "@executablemd/code-review-agent";

const diagnostics = buildDiagnostics(rawDiagnostics, pr, doctor);
```

<ThinkFilter>
<DeepInfraProvider model="Qwen/Qwen3-30B-A3B">
  <Instruction system="You are a precise TypeScript code review assistant for the executable.md monorepo. Be concise. Report only findings, not praise.">
    <GitHubComment>
      <ReleaseSpecWarning files={changedFilePaths} />
      <Format>
        <PrPolicyReport pr={pr} diagnostics={diagnostics} doctor={doctor} />
      </Format>
    </GitHubComment>
  </Instruction>
</DeepInfraProvider>
</ThinkFilter>

</GitHubAuth>

</Output>
