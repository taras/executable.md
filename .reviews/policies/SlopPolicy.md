---
props:
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

<Ratio pr={props.pr}
  numerator="^\s*(?://|/\*|\*)"
  denominator="^\s*\S"
  threshold={0.4}
  minDenominator={20}
  excludeTests={true}
  severity="warning"
  message="Comment ratio is {ratio}%." />

<CommentReview pr={props.pr} />

<OxlintSignals groups={props.diagnostics.byCategory.verbosity}
  label="slop signals" />

</ReviewSection>
