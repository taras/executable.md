---
props:
  type: object
  properties:
    record: {type: object}
    maxSteps: {type: integer, minimum: 1}
    implementationModel: {type: string, minLength: 1}
    implementationModelEvidence: {type: string, pattern: '^/'}
  required: [record]
  additionalProperties: false
returns: {type: object}
---
<If condition={props.implementationModel === undefined && props.implementationModelEvidence === undefined}>
<Ticket.Load record={props.record} as="record" />
<If condition={!record.checkpoint.dispatchable}><Return value={props.record} /><Else><Ticket.Walk record={record} confirmed={props.record} maxSteps={props.maxSteps} as="continued" /><Return value={continued} /></Else></If>
<Else>
<If condition={props.implementationModel === undefined || props.implementationModelEvidence === undefined}><Fail message="Select implementationModel and implementationModelEvidence together." /></If>
<Ticket.SelectModel record={props.record} model={props.implementationModel} evidence={props.implementationModelEvidence} as="selected" />
<If condition={selected.publication !== "confirmed"}><Return value={selected} /><Else>
<Ticket.Load record={selected} as="record" />
<Ticket.Walk record={record} confirmed={selected} maxSteps={props.maxSteps} as="continued" /><Return value={continued} />
</Else></If>
</Else>
</If>
