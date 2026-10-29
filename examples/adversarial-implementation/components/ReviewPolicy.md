---
description: >-
  Select reviewers and Sol effort from an impact assessment. Use
  <ReviewPolicy assessment={assessment} kind="correction" as="policy" />.
props:
  type: object
  properties:
    assessment: {type: object}
    kind: {enum: [feature, correction], default: feature}
  required: [assessment]
  additionalProperties: false
returns: {type: object}
---
<ReviewPolicy.Schema as="schema" />
<Parse schema={schema} as="assessment"><Json value={props.assessment} /></Parse>
<If condition={assessment.mechanical && (assessment.architecture || assessment.acceptance || assessment.risk !== null)}>
<Fail message="A mechanical assessment cannot also affect architecture, acceptance or an unresolved risk." />
</If>
<If condition={!assessment.mechanical && !assessment.architecture && !assessment.acceptance}>
<Fail message="A non-mechanical assessment must identify architecture or acceptance impact." />
</If>
<Return value={{kind:props.kind,assessment,reviewers:[...(assessment.architecture ? ["architect"] : []),...(!assessment.mechanical && (assessment.acceptance || props.kind === "feature") ? ["planner"] : [])],model:"gpt-6.1-sol",effort:assessment.risk === null ? "medium" : "high"}} />
