---
inputs:
  pr:
    type: object
    required: true
  diagnostics:
    type: object
    required: true
  doctor:
    type: object
    required: true
---

## PR #{pr.meta.number}: {pr.meta.title}

**{pr.stats.totalFiles}** files, **+{pr.stats.additions}** / **-{pr.stats.deletions}**

<ScopePolicy pr={pr} />

<BloatPolicy pr={pr} diagnostics={diagnostics} />

<SlopPolicy pr={pr} diagnostics={diagnostics} />

<OxlintSummary diagnostics={diagnostics} doctor={doctor} />

<ExtraneousCodePolicy pr={pr} diagnostics={diagnostics} doctor={doctor} />
