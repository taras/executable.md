---
description: 'Prepare the complete phase prompt before provider dispatch. Use <Phase.Request role="planner" assignment={assignment} as="request" />.'
props:
  type: object
  properties:
    role: {enum: [architect, planner, implementor]}
    assignment: {type: object}
    inputs: {type: array, items: {type: object}, default: []}
    initialize: {type: boolean, default: false}
    correction: {type: [object, 'null'], default: null}
  required: [role, assignment]
  additionalProperties: false
returns: {type: string}
---

<Let as="request"><If condition={props.correction === null}><Phase.Instructions inputs={props.inputs} role={props.role} assignment={props.assignment} initialize={props.initialize} /><Else><Phase.CorrectionInstructions correction={props.correction} /></Else></If></Let>
<If condition={request.length > 64000}><Fail message="The complete phase prompt exceeds 64000 characters. Preserve the prepared assignment and select a smaller evidence packet before dispatch." /></If>
<Return value={request} />
