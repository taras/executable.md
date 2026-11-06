---
props:
  type: object
  properties:
    record: {type: object}
    maxSteps: {type: integer, minimum: 1}
  required: [record]
  additionalProperties: false
returns: {type: object}
---
<Ticket.Load record={props.record} as="record" />
<If condition={!record.checkpoint.dispatchable}><Return value={props.record} /><Else>
<If condition={record.checkpoint.amendment !== undefined}><Ticket.AmendmentSources amendment={record.checkpoint.amendment} as="sources" /></If>
<Ticket.Walk record={record} confirmed={props.record} maxSteps={props.maxSteps} as="continued" /><Return value={continued} /></Else></If>
