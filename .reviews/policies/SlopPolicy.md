---
inputs:
  pr:
    type: object
    required: true
  diagnostics:
    type: object
    required: false
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

<Show when={!!diagnostics && !!diagnostics.byCategory && !!diagnostics.byCategory.verbosity && diagnostics.byCategory.verbosity.length > 0}>

<OxlintSignals groups={diagnostics.byCategory.verbosity}
  label="slop signals" />

</Show>

</ReviewSection>
