---
inputs:
  pr:
    type: object
    required: true
  diagnostics:
    type: object
    required: false
  doctor:
    type: object
    required: false
---

## PR #{pr.meta.number}: {pr.meta.title}

**{pr.stats.totalFiles}** files, **+{pr.stats.additions}** / **-{pr.stats.deletions}**

<ScopePolicy pr={pr} />

<BloatPolicy pr={pr} diagnostics={diagnostics} />

<SlopPolicy pr={pr} diagnostics={diagnostics} />

<Show when={!!diagnostics && !!doctor}>

<OxlintSummary diagnostics={diagnostics} doctor={doctor} />

</Show>

<ExtraneousCodePolicy pr={pr} diagnostics={diagnostics} doctor={doctor} />
