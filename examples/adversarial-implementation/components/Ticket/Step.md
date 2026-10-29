---
description: >-
  Run the next original role and return the updated ticket state. Use
  <Ticket.Step record={record} as="record" /> inside the ticket loop.
props:
  type: object
  properties:
    record: {type: object}
  required: [record]
  additionalProperties: false
returns: {type: object}
---

A held or completed ticket returns without invoking a role. Otherwise check its
inputs, run one phase and preserve the returned execution before settlement.

<Let as="record" value={props.record} />
<If condition={!record.checkpoint.dispatchable}><Return value={record} /></If>
<If condition={record.checkpoint.dispatchable}>
<Ticket.Capture as="preflight">
<Ticket.Check record={record} as="checked" />
<Ticket.Gate record={record} as="selected" />
<Ticket.Inputs record={record} call={selected.call} as="inputSelection" />
<Json value={{selected,...inputSelection}} />
</Ticket.Capture>
<If condition={preflight.status === "failed"}>
<Return value={{...record,checkpoint:{...record.checkpoint,status:"hold",dispatchable:false,hold:{kind:"changed_input",reason:preflight.failure}}}} />
</If>
<If condition={preflight.status !== "failed"}>
<Parse schema={{type:"object"}} as="prepared">{preflight.output}</Parse>
<Let as="selected" value={prepared.selected} />
<Let as="record" value={{...record,documents:prepared.documents,deliveredInputs:prepared.deliveredInputs}} />
<Let as="call" value={{...selected.call,inputs:prepared.inputs}} />
<Ticket.Capture as="execution">
  <Dir path={call.assignment.repository}>
    <Phase.Run phase={call.assignment.phase} role={call.role} session={call.session}
      assignment={call.assignment} attempt={call.attempt} initialize={call.initialize}
      inputs={call.inputs} implementationProvider={call.provider} successor={call.assignment.continuation.phase}
      nextRole={call.assignment.continuation.role} responseProfile={{kind:"ticket",knownDocuments:Object.keys(record.documents)}} as="result" />
  </Dir>
</Ticket.Capture>
<Let as="recordDirectory" value={"'" + call.record.replaceAll("'", "'\"'\"'") + "'"} />
```bash exec as="saved"
mkdir -- {recordDirectory}
```
<If condition={saved.exitCode !== 0}><Fail message={saved.stderr || saved.stdout} /></If>
<Dir path={call.record}>
<File path="call.json"><Json value={call} /></File>
<File path="execution.json"><Json value={execution} /></File>
</Dir>
<Ticket.Capture as="canonical">
  <Ticket.Text path={call.attempt + "/result.json"} as="resultText" />
  <Parse schema={{type:"object"}} as="result">{resultText}</Parse>
  <Json value={result} />
</Ticket.Capture>
<Let as="result" value={null} />
<If condition={canonical.status === "completed"}><Parse schema={{type:"object"}} as="result">{canonical.output}</Parse></If>
<Ticket.Settle pending={{...record,checkpoint:selected.checkpoint,call,execution,result,resultPath:call.attempt + "/result.json"}} as="settled" />
<Return value={settled} />
</If>
</If>
