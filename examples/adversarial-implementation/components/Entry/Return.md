---
props:
  type: object
  properties:
    record: {type: string}
  required: [record]
  additionalProperties: false
returns: {type: object}
---
<Ticket.Read path={props.record} limit={65536} as="text" />
<Parse schema={{type:"object"}} as="envelope">{text}</Parse>
<Ticket.Envelope value={envelope} as="envelope" />
<If condition={envelope.publication === "confirmed"}>
<Ticket.Capture as="validation"><Ticket.Load record={envelope} as="saved" /></Ticket.Capture>
<If condition={validation.status !== "completed"}><Let as="envelope" value={{...envelope,status:"hold",publication:"held",hold:"Confirmed continuation is unavailable or invalid. No state was adopted; operator disposition is required."}} /></If>
</If>
<Ticket.Outward value={envelope} as="bounded" />
<Return value={bounded} />
