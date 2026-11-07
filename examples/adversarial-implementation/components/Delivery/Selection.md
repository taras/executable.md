---
description: 'Select the ordered independent reviewers a delivery permits for one revision. Use <Delivery.Selection delivery={delivery} revision={revision} as="selection" />.'
props:
  type: object
  properties:
    delivery: {type: object}
    revision: {type: string, pattern: '^[0-9a-f]{40}$'}
  required: [delivery, revision]
  additionalProperties: false
returns: {type: object}
---

A Fable reviewer is followed by one independent Codex Astra replacement in its
own conversation. An Astra policy is already the final reviewer, and any other
reviewer is the only one.

<Delivery.Schema as="schemas" />
<Let as="reviewer" value={props.delivery.policy.reviewer} />
<Let as="fable" value={reviewer.provider === "claude" && (reviewer.model === "fable" || reviewer.model.startsWith("claude-fable-"))} />
<Let as="astra" value={reviewer.provider === "codex" && reviewer.model === "gpt-6-astra"} />
<Let as="replacement" value={{provider:"codex",model:"gpt-6-astra",effort:reviewer.effort,session:reviewer.session + "-astra"}} />
<Return value={{schema:"delivery-review-selection.v1",work:props.delivery.work,repository:props.delivery.repository,revision:props.revision,policy:props.delivery.policy,inputs:props.delivery.inputs,responseSchema:schemas.review,chain:fable ? "fable-astra" : astra ? "astra-final" : "single",reviewers:fable ? [{reviewer,choices:[...new Set(["fable",reviewer.model])]},{reviewer:replacement,choices:["gpt-6-astra"]}] : [{reviewer,choices:[reviewer.model]}]}} />
