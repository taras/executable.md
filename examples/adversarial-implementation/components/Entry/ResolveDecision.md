---
props:
  type: object
  properties:
    record: {type: string}
    decision: {type: string}
  required: [record, decision]
  additionalProperties: false
returns: {type: object}
---
<Ticket.Read path={props.record} limit={65536} as="text" />
<Parse schema={{type:"object"}} as="envelope">{text}</Parse>
<Ticket.Envelope value={envelope} as="envelope" />
<Ticket.Capture as="resolved"><Ticket.ResolveDecision record={envelope} decision={props.decision} as="work" /><Json value={work} /></Ticket.Capture>
<If condition={resolved.status === "completed"}>
<Parse schema={{type:"object"}} as="work">{resolved.output}</Parse>
<Ticket.Outward value={work} as="bounded" /><Return value={bounded} />
<Else><Ticket.Outward value={{schema:"ticket-return.v1",work:envelope.work,source:envelope.source,status:"hold",revision:envelope.revision,publication:"held",continuation:envelope.continuation,pending:null,hold:"Decision resolution was refused without changing the managed ticket. Keep the original envelope; correct the decision input or follow the hold's existing recovery.",failure:{name:"DecisionRefused",message:resolved.failure.split("\n").filter(line => !/^\s+at /.test(line)).join("\n").slice(0,1024),data:null}}} as="bounded" /><Return value={bounded} /></Else>
</If>
