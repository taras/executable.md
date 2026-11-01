---
description: 'Supply omitted assignment metadata without replacing a verdict. Use <Phase.Metadata assignment={assignment} value={reply} as="reply" />.'
props:
  type: object
  properties:
    assignment: {type: object}
    value: {type: object}
  required: [assignment, value]
  additionalProperties: false
returns: {type: object}
---

<Let as="value" value={props.value} />
<Let as="known" value={{phase:props.assignment.phase,work:props.assignment.work,...(props.assignment.phase === "implementation" ? {} : {revision:props.assignment.revision}),...(["pass","complete"].includes(value.outcome) && props.assignment.continuation ? {next:props.assignment.continuation} : {})}} />
<Return value={{...known,...value}} />
