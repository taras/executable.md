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
description: >-
  Compose the whole repository analysis. `<RepoPolicyReport diagnostics={diagnostics}
  doctor={doctor} fileList={files} fileCount={count} lineCount={lines} />` renders the
  static-analysis and cleanup sections. With the configured GitHub environment, it
  also creates, updates and closes cleanup issues for the five highest-ranked file
  clusters.
---

## Repository Analysis

**{props.fileCount}** TypeScript files, **{props.lineCount}** total lines

<OxlintSummary diagnostics={props.diagnostics} doctor={props.doctor} />

<RepoCleanupPolicy diagnostics={props.diagnostics} doctor={props.doctor} fileList={props.fileList} cleanupAnalysis={props.cleanupAnalysis} />

<CleanupIssues cleanupAnalysis={props.cleanupAnalysis} diagnostics={props.diagnostics} />
