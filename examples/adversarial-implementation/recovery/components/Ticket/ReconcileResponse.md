---
description: >-
  Revalidate an original joined reply without prompting. Use
  <Ticket.ReconcileResponse record={held} proof="/absolute/work/recovery-proof.json"
  as="recovered" />, then advance its confirmed return through the owning workflow.
props:
  type: object
  properties:
    record: {type: object}
    proof: {type: string, pattern: '^/'}
    resume: {type: [string, 'null'], pattern: '^/', default: null}
  required: [record, proof]
  additionalProperties: false
returns: {type: object}
---

<Ticket.Envelope value={props.record} as="envelope" />
<Let as="pending" value={null} />
<Ticket.Capture as="loaded"><Ticket.Load record={envelope} as="saved" /><Json value={saved} /></Ticket.Capture>
<If condition={loaded.status === "completed"}>
<Parse schema={{type:"object"}} as="saved">{loaded.output}</Parse>
<Let as="call" value={saved.calls.at(-1)} />
<If condition={call !== undefined}>
<Let as="pending" value={{result:(saved.checkpoint.feedback.find(path => /\/reconciliations\/[0-9a-f]{64}\/result\.json$/.test(path)) ?? saved.manifest.directory + "/reconciliations/" + envelope.continuation.sha256 + "/result.json"),execution:call.execution,call:call.record + "/call.json"}} />
</If>
</If>
<Ticket.Capture as="reconciled">
<If condition={loaded.status !== "completed"}><Fail message={loaded.failure} /></If>
<Ticket.ReconcileOriginal record={envelope} proof={props.proof} resume={props.resume} as="result" /><Json value={result} />
</Ticket.Capture>
<If condition={reconciled.status === "completed"}>
<Parse schema={{type:"object"}} as="result">{reconciled.output}</Parse>
<Ticket.Outward value={result} as="bounded" /><Return value={bounded} />
<Else>
<Ticket.Outward value={{schema:"ticket-return.v1",work:envelope.work,source:envelope.source,status:"hold",revision:envelope.revision,publication:"held",continuation:envelope.continuation,pending,hold:"Reconciliation did not return an acknowledged successor. Preserve the original record and reserved paths; matching files do not authorize publication.",failure:{name:"JoinedResponseRefused",message:reconciled.failure.split("\n").filter(line => !/^\s+at /.test(line)).join("\n").slice(0,1024),data:null}}} as="bounded" /><Return value={bounded} />
</Else>
</If>
