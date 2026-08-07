---
props:
  type: object
  properties:
    diagnostics:
      type: object
    doctor:
      type: object
  required: [diagnostics, doctor]
  additionalProperties: false
---

<ReviewSection heading="Static Analysis"
  clean="✅ Oxlint found no issues.">

<Show when={!props.doctor.oxlintInstalled}>

🟡 Oxlint not installed. Static analysis skipped.

</Show>

<Show when={props.doctor.oxlintInstalled && props.diagnostics.total > 0}>

{props.diagnostics.summary}

</Show>

<Show when={props.doctor.bloatRulesMissing.length > 0
         && props.doctor.oxlintInstalled}>

*{props.doctor.bloatRulesMissing.length} type-aware rules unavailable
— install `oxlint-tsgolint` for full coverage.*

</Show>

</ReviewSection>
