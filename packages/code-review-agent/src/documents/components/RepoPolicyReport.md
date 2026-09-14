---
props:
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

**{props.fileCount}** TypeScript files, **{props.lineCount}** total lines

<OxlintSummary diagnostics={props.diagnostics} doctor={props.doctor} />

<RepoCleanupPolicy diagnostics={props.diagnostics} doctor={props.doctor} fileList={props.fileList} cleanupAnalysis={props.cleanupAnalysis} />

<CleanupIssues cleanupAnalysis={props.cleanupAnalysis} diagnostics={props.diagnostics} />
