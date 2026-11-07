---
description: 'Send one reserved review attempt to its selected reviewer and retain the joined execution. Use <Delivery.Dispatch delivery={delivery} selection={selection} position={0} attempt={directory} />.'
props:
  type: object
  properties:
    delivery: {type: object}
    selection: {type: object}
    position: {type: integer, minimum: 0, maximum: 1}
    attempt: {type: string, pattern: '^/'}
  required: [delivery, selection, position, attempt]
  additionalProperties: false
---

<Let as="entry" value={props.selection.reviewers[props.position]} />
<Dir path={props.attempt}><File path="assignment.json"><Json value={{work:props.selection.work,revision:props.selection.revision,reviewer:entry.reviewer,acceptance:props.selection.policy.acceptance,responseSchema:props.selection.responseSchema}} /></File></Dir>
<Ticket.Capture as="execution"><Delivery.Role delivery={props.delivery} revision={props.selection.revision} reviewer={entry.reviewer} choices={entry.choices} position={props.position} attempt={props.attempt} as="outcome" /><Json value={outcome} /></Ticket.Capture>
<Dir path={props.attempt}><File path="execution.json"><Json value={execution} /></File></Dir>
