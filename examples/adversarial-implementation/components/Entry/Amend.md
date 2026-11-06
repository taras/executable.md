---
props:
  type: object
  properties:
    record: {type: string}
    grant: {type: string}
    action: {enum: [admit, select], default: admit}
  additionalProperties: false
returns: {type: object}
---
<If condition={props.action === "select"}>
<Ticket.AmendmentProgram as="program" />
<Let as="workflowQuoted" value={"'" + program.root.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="workflow"
git -C {workflowQuoted} rev-parse HEAD
```
<Ticket.Outward value={{...program,revision:workflow.exitCode === 0 ? workflow.stdout.trim() : null}} as="bounded" /><Return value={bounded} />
<Else>
<If condition={props.record === undefined || props.grant === undefined}><Fail message="Admission needs --props-record with the completed ticket envelope and --props-grant with its protected authorization record." /></If>
<Ticket.Read path={props.record} limit={65536} as="text" />
<Parse schema={{type:"object"}} as="envelope">{text}</Parse>
<Ticket.Envelope value={envelope} as="envelope" />
<Ticket.Capture as="admission"><Ticket.Amend record={envelope} grant={props.grant} as="work" /><Json value={work} /></Ticket.Capture>
<If condition={admission.status === "completed"}>
<Parse schema={{type:"object"}} as="work">{admission.output}</Parse>
<Ticket.Outward value={work} as="bounded" /><Return value={bounded} />
<Else><Ticket.Outward value={{schema:"ticket-return.v1",work:envelope.work,source:envelope.source,status:"hold",revision:envelope.revision,publication:"held",continuation:envelope.continuation,pending:null,hold:"Delivery amendment was refused: " + admission.failure.split("\n")[0] + " Preserve the original records and resolve this before another admission."}} as="bounded" /><Return value={bounded} /></Else>
</If>
</Else>
</If>
