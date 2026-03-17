---
inputs:
  diagnostics:
    type: object
    required: true
  doctor:
    type: object
    required: true
  fileList:
    type: string
    required: true
  fileCount:
    type: number
    required: true
  lineCount:
    type: number
    required: true
---

## Repository Analysis

**{fileCount}** TypeScript files, **{lineCount}** total lines

<OxlintSummary diagnostics={diagnostics} doctor={doctor} />

<RepoSemanticReview diagnostics={diagnostics} doctor={doctor} fileList={fileList} />
