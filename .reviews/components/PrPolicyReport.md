---
inputs:
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

## PR #{pr.meta.number}: {pr.meta.title}

**{pr.stats.totalFiles}** files, **+{pr.stats.additions}** / **-{pr.stats.deletions}**

<ScopePolicy pr={pr} />

<BloatPolicy pr={pr} diagnostics={diagnostics} />

<SlopPolicy pr={pr} diagnostics={diagnostics} />

<OxlintSummary diagnostics={diagnostics} doctor={doctor} />

<ExtraneousCodePolicy pr={pr} diagnostics={diagnostics} doctor={doctor} />
