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

<If condition={!doctor.oxlintInstalled}>

🟡 Oxlint not installed. Static analysis skipped.

</If>

<If condition={doctor.oxlintInstalled && diagnostics.total > 0}>

{diagnostics.summary}

</If>

<If condition={doctor.bloatRulesMissing.length > 0
            && doctor.oxlintInstalled}>

*{doctor.bloatRulesMissing.length} type-aware rules unavailable
— install `oxlint-tsgolint` for full coverage.*

</If>

</ReviewSection>
