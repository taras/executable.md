---
inputs:
  pr:
    type: object
    required: true
---

<ReviewSection heading="Verbosity" clean="✅ Comment quality looks reasonable.">

<Ratio pr={pr}
  numerator="^\s*(?://|/\*|\*)"
  denominator="^\s*\S"
  threshold={0.4}
  minDenominator={20}
  excludeTests={true}
  severity="warning"
  message="Comment ratio is {ratio}%." />

<CommentReview pr={pr} />

</ReviewSection>
