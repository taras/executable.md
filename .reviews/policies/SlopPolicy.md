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

<ReviewSection heading="Slop" clean="✅ Slop indicators look low.">

<Ratio pr={pr}
  numerator="^\s*(?://|/\*|\*)"
  denominator="^\s*\S"
  threshold={0.4}
  minDenominator={20}
  excludeTests={true}
  severity="warning"
  message="Comment ratio is {ratio}%." />

<CommentReview pr={pr} />

<OxlintSignals groups={diagnostics.byCategory.verbosity}
  label="slop signals" />

</ReviewSection>
