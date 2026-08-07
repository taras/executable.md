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
---

## PR #{props.pr.meta.number}: {props.pr.meta.title}

**{props.pr.stats.totalFiles}** files, **+{props.pr.stats.additions}** / **-{props.pr.stats.deletions}**

<ScopePolicy pr={props.pr} />

<BloatPolicy pr={props.pr} diagnostics={props.diagnostics} />

<SlopPolicy pr={props.pr} diagnostics={props.diagnostics} />

<OxlintSummary diagnostics={props.diagnostics} doctor={props.doctor} />

<ExtraneousCodePolicy pr={props.pr} diagnostics={props.diagnostics} doctor={props.doctor} />
