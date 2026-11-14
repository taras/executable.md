---
props:
  type: object
  properties:
    assignment: {type: object}
    previous: {type: object}
    inputs: {type: array}
  required: [assignment]
  additionalProperties: false
---

<If condition={props.previous !== undefined && (props.previous.question !== props.assignment.question || JSON.stringify(props.previous.constraints) !== JSON.stringify(props.assignment.constraints))}>
<Fail message="The design question or constraints differ from the original assignment. Use a fresh assignment for a different decision." />
</If>
<If condition={props.inputs?.length === 0 && props.assignment.specs === undefined}>
<Fail message="Supply a relevant spec section or captured evidence for the design assignment." />
</If>
