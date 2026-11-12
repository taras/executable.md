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

<Phase.SubmissionGuide repository={props.assignment.repository} directory={props.assignment.artifactDirectory} mode="check" as="submission"><Phase.SubmissionInstructions role={props.role} assignment={props.assignment} /></Phase.SubmissionGuide>
<Let as="request"><If condition={props.correction === null}><Phase.Instructions inputs={props.inputs} role={props.role} assignment={props.assignment} initialize={props.initialize} submission={submission} /><Else><Phase.CorrectionInstructions correction={props.correction} /></Else></If></Let>
<If condition={request.length > 256000}><Fail message={"The complete phase prompt exceeds 256000 characters (actual " + request.length + "), including mandatory instructions and selected evidence. Selected inputs: " + props.inputs.map(input => input.path + " (" + input.content.length + ")").join(", ") + ". Preserve the prepared assignment and reduce the request before dispatch; nothing was truncated or sent. No provider prompt began."} /></If>
<Return value={request} />
