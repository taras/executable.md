---
description: >-
  Revalidate a retained original joined reply without another provider call.
props:
  type: object
  properties:
    record: {type: string, pattern: '^/'}
    proof: {type: string, pattern: '^/'}
  required: [record, proof]
  additionalProperties: false
returns: {type: object}
---

<Ticket.Read path={props.record} limit={65536} as="recordText" />
<Parse schema={{type:"object"}} as="record">{recordText}</Parse>
<Ticket.Envelope value={record} as="record" />
<Ticket.Capture as="reconciliation"><Ticket.ReconcileResponse record={record} proof={props.proof} as="successor" /><Json value={successor} /></Ticket.Capture>
<If condition={reconciliation.status === "completed"}>
<Parse schema={{type:"object"}} as="successor">{reconciliation.output}</Parse>
<Ticket.Outward value={successor} as="bounded" />
<Else>
<Ticket.Outward value={{schema:"ticket-return.v1",work:record.work,source:record.source,status:"hold",revision:record.revision,publication:"held",continuation:record.continuation,pending:null,hold:"Reconciliation did not return an acknowledged successor. Preserve the original record and reservation; matching files do not authorize another publication.",failure:{name:"JoinedResponseRefused",message:reconciliation.failure.split("\n").filter(line => !/^\s+at /.test(line)).join("\n").slice(0,1024),data:null}}} as="bounded" />
</Else>
</If>

<Return value={bounded} />
