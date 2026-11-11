---
description: 'Send one reserved review attempt to its selected reviewer and record that its provider scope released. Use <Delivery.Dispatch delivery={delivery} selection={selection} position={0} attempt={directory} />.'
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

`execution.json` is written only after the role's provider scope has released.
A release that fails ends the run and leaves the attempt reserved, so it holds
for reconciliation and can never select a replacement.

<Let as="entry" value={props.selection.reviewers[props.position]} />
<Dir path={props.attempt}><File path="assignment.json"><Json value={{work:props.selection.work,revision:props.selection.revision,reviewer:entry.reviewer,acceptance:props.selection.policy.acceptance,responseSchema:props.selection.responseSchema,...(props.selection.maxResponseCorrections === undefined ? {} : {maxResponseCorrections:props.selection.maxResponseCorrections})}} /></File></Dir>
<Try>
<Delivery.Role delivery={props.delivery} revision={props.selection.revision} reviewer={entry.reviewer} choices={entry.choices} position={props.position} attempt={props.attempt} />
<Dir path={props.attempt}><File path="execution.json"><Json value={{status:"completed",failure:null}} /></File></Dir>
<Catch as="error">
<Dir path={props.attempt}><File path="execution.json"><Json value={{status:"failed",failure:error.name + ": " + error.message}} /></File></Dir>
</Catch>
</Try>
