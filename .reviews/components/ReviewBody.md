---
inputs:
  pr:
    type: object
    required: true
---

## PR #{pr.meta.number}: {pr.meta.title}

**{pr.stats.totalFiles}** files, **+{pr.stats.additions}** / **-{pr.stats.deletions}**

<ScopeCheck pr={pr} />

<StructuralBloat pr={pr} />

<VerbosityCheck pr={pr} />

<SemanticReview pr={pr} />
