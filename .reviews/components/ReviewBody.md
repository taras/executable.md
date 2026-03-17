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

<ScopeCheck pr={pr} />

<StructuralBloat pr={pr} diagnostics={diagnostics} />

<VerbosityCheck pr={pr} />

<Show when={diagnostics && doctor}>

<OxlintSummary diagnostics={diagnostics} doctor={doctor} />

</Show>

<SemanticReview pr={pr} diagnostics={diagnostics} doctor={doctor} />
