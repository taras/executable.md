---
props:
  type: object
  properties:
    record: {type: string}
    decision: {type: string}
  required: [record, decision]
  additionalProperties: false
---
<Ticket.Read path={props.record} limit={65536} as="text" />
<Parse schema={{type:"object"}} as="envelope">{text}</Parse>
<Ticket.Capture as="resolved"><Ticket.ResolveDecision record={envelope} decision={props.decision} as="work" /><Json value={work} /></Ticket.Capture>
<Output><Json value={resolved} /></Output>
