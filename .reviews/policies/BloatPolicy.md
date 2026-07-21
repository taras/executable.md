---
inputs:
  type: object
  properties:
    pr:
      type: object
    diagnostics:
      type: object
  required: [pr, diagnostics]
  additionalProperties: false
---

<ReviewSection heading="Structural" clean="✅ No structural bloat detected.">

<UnusedInDiff pr={pr} construct="type"
  severity="warning"
  message="Type declarations with no consumers: {names}." />

<UnusedInDiff pr={pr} construct="interface"
  severity="warning"
  message="Interface declarations with no consumers: {names}." />

<Ratio pr={pr}
  numerator=":\s*any\b"
  denominator=":\s*\w"
  threshold={0.05}
  minDenominator={10}
  excludeTests={true}
  severity="warning"
  message="{numeratorCount} uses of `any` ({ratio}% of annotations)." />

<Pattern pr={pr}
  pattern="(?:function\s+\w+|=>\s*)\([^)]*\)\s*\{\s*\}"
  excludeTests={true}
  severity="warning"
  message="{count} empty function bodies." />

<Pattern pr={pr}
  pattern="console\.(log|debug|info|trace)\("
  excludeTests={true}
  severity="warning"
  message="{count} console statements." />

<OxlintSignals groups={diagnostics.byCategory.structural}
  label="structural signals" />

</ReviewSection>
