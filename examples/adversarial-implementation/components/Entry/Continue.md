---
props:
  type: object
  properties:
    record: {type: string}
    steps: {type: integer, minimum: 1, default: 1}
  required: [record]
  additionalProperties: false
returns: {type: object}
---
<Ticket.Read path={props.record} limit={65536} as="text" />
<Parse schema={{type:"object"}} as="envelope">{text}</Parse>
<Ticket.Envelope value={envelope} as="envelope" />
<If condition={envelope.publication === "held"}><Ticket.Outward value={envelope} as="bounded" /><Return value={bounded} /><Else>
<Ticket.Capture as="continued"><Ticket.Continue record={envelope} maxSteps={props.steps} as="work" /><Json value={work} /></Ticket.Capture>
<If condition={continued.status === "completed"}>
<Parse schema={{type:"object"}} as="work">{continued.output}</Parse>
<Ticket.Outward value={work} as="bounded" /><Return value={bounded} />
<Else><Return value={{...envelope,status:"hold",publication:"held",hold:"Continuation was refused. Preserve original evidence and resolve the existing hold before dispatch."}} /></Else>
</If>

</Else></If>
