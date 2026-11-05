---
description: >-
  Run the next original role and publish its settled continuation. Use
  <Ticket.Step record={record} previous={confirmed} as="stepped" /> inside the ticket loop.
props:
  type: object
  properties:
    record: {type: object}
    previous: {type: [object, 'null'], default: null}
  required: [record]
  additionalProperties: false
returns: {type: object}
---

A held or completed ticket returns without invoking a role. Otherwise check its
inputs, run one phase and preserve the returned execution before settlement.

<Let as="record" value={props.record} />
<If condition={!record.checkpoint.dispatchable}><Return value={{record,envelope:props.previous}} /></If>
<If condition={record.checkpoint.dispatchable}>
<Ticket.Gate record={record} as="selected" />
<Let as="pendingReferences" value={{result:selected.call.attempt + "/result.json",execution:selected.call.record + "/execution.json",call:selected.call.record + "/call.json"}} />
<Let as="recordDirectory" value={"'" + selected.call.record.replaceAll("'", "'\"'\"'") + "'"} />
```bash exec as="reserved"
mkdir -- {recordDirectory}
```
<If condition={reserved.exitCode !== 0}><Return value={{record:null,envelope:{schema:"ticket-return.v1",work:record.manifest.work,source:record.manifest.assignment.revision,status:"hold",revision:record.checkpoint.revision,publication:"held",continuation:props.previous?.continuation ?? null,pending:pendingReferences,hold:"This call already has retained work or its directory is unavailable. Preserve the prior state and original receipts; no role or source validation was repeated."}}} /><Else>
<Ticket.Capture as="preflight">
<Ticket.Check record={record} as="checked" />
<Ticket.Inputs record={record} call={selected.call} as="inputSelection" />
<Json value={{selected,...inputSelection}} />
</Ticket.Capture>
<If condition={preflight.status === "failed"}>
<Let as="held" value={{...record,checkpoint:{...record.checkpoint,status:"hold",dispatchable:false,hold:{kind:"changed_input",reason:preflight.failure}}}} /><Ticket.Publish record={held} previous={props.previous} as="published" /><Return value={{record:published.publication === "confirmed" ? held : null,envelope:published}} />
</If>
<If condition={preflight.status !== "failed"}>
<Parse schema={{type:"object"}} as="prepared">{preflight.output}</Parse>
<Let as="selected" value={prepared.selected} />
<Let as="record" value={{...record,documents:prepared.documents,deliveredInputs:prepared.deliveredInputs}} />
<Let as="call" value={{...selected.call,inputs:prepared.inputs.map(input => record.documents[input.path])}} />
<Ticket.SaveMetadata name="call" repository={call.assignment.repository} path={call.record + "/call.json"} as="callReceipt" />
<Ticket.Capture as="execution">
  <Dir path={call.assignment.repository}>
    <Phase.Run phase={call.assignment.phase} role={call.role} session={call.session}
      assignment={call.assignment} attempt={call.attempt} initialize={call.initialize}
      inputs={prepared.inputs} plannerProvider={call.provider} implementationProvider={call.provider} maxResponseCorrections={record.manifest.maxResponseCorrections} successor={call.assignment.continuation.phase}
      nextRole={call.assignment.continuation.role} responseProfile={{kind:"ticket",knownDocuments:Object.keys(record.documents)}} as="result" />
  </Dir>
</Ticket.Capture>
<Ticket.SaveMetadata name="execution" repository={call.assignment.repository} path={call.record + "/execution.json"} as="executionReceipt" />
<Ticket.Capture as="canonical">
  <Ticket.Read path={call.attempt + "/result.json"} as="resultText" />
  <Parse schema={{type:"object"}} as="result">{resultText}</Parse>
  <Json value={result} />
</Ticket.Capture>
<Let as="result" value={null} />
<If condition={canonical.status === "completed"}><Parse schema={{type:"object"}} as="result">{canonical.output}</Parse></If>
<Ticket.Capacity name="result" as="resultFits" />
<If condition={resultFits}>
<Ticket.Settle pending={{...record,checkpoint:selected.checkpoint,call,execution,result,resultPath:call.attempt + "/result.json"}} as="settled" />
<Ticket.Capacity name="settled" as="fits" />
<Let as="pendingReferences" value={{result:call.attempt + "/result.json",execution:call.record + "/execution.json",call:call.record + "/call.json"}} />
<If condition={!fits}>
<Return value={{record:null,envelope:{schema:"ticket-return.v1",work:record.manifest.work,source:record.manifest.assignment.revision,status:"hold",revision:record.checkpoint.revision,publication:"held",continuation:props.previous?.continuation ?? null,pending:pendingReferences,hold:"Continuation capacity exceeded. Preserve the previous state and canonical result; no successor was dispatched."}}} />
<Else><Ticket.Publish record={settled} previous={props.previous} pending={pendingReferences} as="published" /><Return value={{record:published.publication === "confirmed" ? settled : null,envelope:published}} /></Else>
</If>
<Else><Return value={{record:null,envelope:{schema:"ticket-return.v1",work:record.manifest.work,source:record.manifest.assignment.revision,status:"hold",revision:record.checkpoint.revision,publication:"held",continuation:props.previous?.continuation ?? null,pending:{result:call.attempt + "/result.json",execution:call.record + "/execution.json",call:call.record + "/call.json"},hold:"Incoming metadata exceeds continuation capacity. The canonical role result is saved; no successor was dispatched."}}} /></Else>
</If>
</If>
</If>

</Else></If>
