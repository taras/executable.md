---
description: 'Select the fixed role model. Use <Phase.Profile role="planner" assessment={assessment} as="profile" />.'
props:
  type: object
  properties:
    role: {enum: [architect, planner, implementor]}
    assessment: {type: object}
    design: {type: boolean, default: false}
    plannerProvider: {enum: [claude, codex], default: claude}
    implementationProvider: {enum: [claude, codex], default: claude}
  required: [role, assessment]
  additionalProperties: false
returns: {type: object}
---

<ReviewPolicy assessment={props.assessment} as="policy" />
<Return value={props.role === "planner" && props.plannerProvider === "claude" ? {provider:"claude",model:"opus",effort:props.design ? "high" : policy.effort} : props.role === "implementor" && props.implementationProvider === "claude" ? {provider:"claude",model:"sonnet",effort:"high"} : {provider:"codex",model:policy.model,effort:props.role === "planner" && props.design ? "high" : policy.effort}} />
