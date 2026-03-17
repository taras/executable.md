---
inputs:
  diagnostics:
    type: object
    required: true
  doctor:
    type: object
    required: true
---

<ReviewSection heading="Static Analysis"
  clean="✅ Oxlint found no issues.">

<Show when={!doctor.oxlintInstalled}>

🟡 Oxlint not installed. Static analysis skipped.

</Show>

<Show when={doctor.oxlintInstalled && diagnostics.total > 0}>

{diagnostics.summary}

</Show>

<Show when={doctor.bloatRulesMissing.length > 0
         && doctor.oxlintInstalled}>

*{doctor.bloatRulesMissing.length} type-aware rules unavailable
— install `oxlint-tsgolint` for full coverage.*

</Show>

</ReviewSection>
