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

<If condition={!props.doctor.oxlintInstalled}>

🟡 Oxlint not installed. Static analysis skipped.

</If>

<If condition={props.doctor.oxlintInstalled && props.diagnostics.total > 0}>

{props.diagnostics.summary}

</If>

<If condition={props.doctor.bloatRulesMissing.length > 0
         && props.doctor.oxlintInstalled}>

*{props.doctor.bloatRulesMissing.length} type-aware rules unavailable
— install `oxlint-tsgolint` for full coverage.*

</If>

</ReviewSection>
