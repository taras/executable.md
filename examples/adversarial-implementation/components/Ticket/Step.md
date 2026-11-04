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
<Ticket.Prepare record={record} call={selected.call} as="inputSelection" />
<Json value={{selected,...inputSelection}} />
</Ticket.Capture>
<If condition={preflight.status === "failed"}>
<Return value={{...record,checkpoint:{...record.checkpoint,status:"hold",dispatchable:false,hold:{kind:"changed_input",reason:preflight.failure}}}} />
</If>
<If condition={preflight.status !== "failed"}>
<Parse schema={{type:"object"}} as="prepared">{preflight.output}</Parse>
<Let as="selected" value={prepared.selected} />
<Let as="record" value={{...record,documents:prepared.documents}} />
<If condition={prepared.status === "hold"}>
<Return value={{...record,checkpoint:{...record.checkpoint,status:"hold",dispatchable:false,hold:{kind:"input_preparation",reason:prepared.reason,receipt:prepared.receipt}}}} />
<Else>
<Let as="call" value={{...prepared.call,inputs:prepared.inputs,preparation:prepared.receipt}} />
<Ticket.Capture as="execution">
  <Dir path={call.assignment.repository}>
    <Phase.Run phase={call.assignment.phase} role={call.role} session={call.session}
      assignment={call.assignment} attempt={call.attempt} initialize={call.initialize}
      inputs={call.inputs} plannerProvider={call.provider} implementationProvider={call.provider} maxResponseCorrections={record.manifest.maxResponseCorrections} successor={call.assignment.continuation.phase}
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
<Ticket.Capture as="deliveryCapture"><Ticket.Text path={call.attempt + "/delivery.json"} as="text" /><Json value={text} /></Ticket.Capture>
<Let as="delivery" value={null} />
<If condition={deliveryCapture.status === "completed"}>
<Parse schema={{type:"string"}} as="deliveryText">{deliveryCapture.output}</Parse>
<Parse schema={{type:"object"}} as="delivery">{deliveryText}</Parse>
<If condition={delivery.role !== call.role || delivery.session !== call.session || delivery.provider !== call.provider}><Fail message="Delivery witness names another recipient." /></If>
<Ticket.Fingerprint inputs={call.inputs} as="expectedInputs" />
<If condition={JSON.stringify(delivery.inputs) !== JSON.stringify(expectedInputs)}><Fail message="Delivery witness differs from the selected packet." /></If>
<Let as="record" value={{...record,deliveredInputs:prepared.deliveryProposal}} />
</If>
<Let as="checkpoint" value={{...selected.checkpoint,initialized:{...record.checkpoint.initialized,[call.role]:delivery !== null || record.checkpoint.initialized[call.role]}}} />
<Let as="call" value={{...call,delivery:delivery === null ? null : call.attempt + "/delivery.json",profile:delivery?.profile ?? null}} />
<Dir path={prepared.receipt.slice(0,prepared.receipt.lastIndexOf("/"))}><File path="dispatch.json"><Json value={{call:call.record + "/call.json",role:call.role,session:call.session,attempt:call.attempt,execution:call.record + "/execution.json",result:result === null ? null : call.attempt + "/result.json",delivery:call.delivery}} /></File></Dir>
<Ticket.Settle pending={{...record,checkpoint,call,execution,result,resultPath:call.attempt + "/result.json"}} as="settled" />
<Return value={settled} />
</Else>
</If>
</If>
