---
inputs:
  type: object
  properties:
    diagnostics:
      type: object
    doctor:
      type: object
    fileList:
      type: string
    fileCount:
      type: number
    lineCount:
      type: number
    cleanupAnalysis:
      type: object
  required: [diagnostics, doctor, fileList, fileCount, lineCount]
  additionalProperties: false
---

## Repository Analysis

**{fileCount}** TypeScript files, **{lineCount}** total lines

<OxlintSummary diagnostics={diagnostics} doctor={doctor} />

<RepoCleanupPolicy diagnostics={diagnostics} doctor={doctor} fileList={fileList} cleanupAnalysis={cleanupAnalysis} />

<CleanupIssues cleanupAnalysis={cleanupAnalysis} diagnostics={diagnostics} />
