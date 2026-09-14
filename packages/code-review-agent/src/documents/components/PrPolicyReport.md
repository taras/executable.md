---
props:
  type: object
  properties:
    pr:
      type: object
    diagnostics:
      type: object
    doctor:
      type: object
  required: [pr, diagnostics, doctor]
  additionalProperties: false
description: >-
  Compose the whole pull-request review. `<PrPolicyReport pr={pr}
  diagnostics={diagnostics} doctor={doctor} />` renders the scope, structural, slop,
  static-analysis and correctness sections under one heading. When redundant comments
  remain and the required GitHub environment is present, it also reconciles inline
  removal suggestions on the pull request.
---

## PR #{props.pr.meta.number}: {props.pr.meta.title}

**{props.pr.stats.totalFiles}** files, **+{props.pr.stats.additions}** / **-{props.pr.stats.deletions}**

<ScopePolicy pr={props.pr} />

<BloatPolicy pr={props.pr} diagnostics={props.diagnostics} />

<SlopPolicy pr={props.pr} diagnostics={props.diagnostics} />

<OxlintSummary diagnostics={props.diagnostics} doctor={props.doctor} />

<ExtraneousCodePolicy pr={props.pr} diagnostics={props.diagnostics} doctor={props.doctor} />
