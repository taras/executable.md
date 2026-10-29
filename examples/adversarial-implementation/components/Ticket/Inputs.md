---
description: >-
  Prepare only the documents selected for this retained role. Use
  <Ticket.Inputs record={record} call={call} as="prepared" /> before dispatch.
props:
  type: object
  properties:
    record: {type: object}
    call: {type: object}
  required: [record, call]
  additionalProperties: false
returns: {type: object}
---

Accepted inputs are supplied once to each original session. A returned
handoff selects additional documents explicitly. Artifact and log references
remain available without adding their contents to the prompt.

<Let as="received" value={props.record.deliveredInputs?.[props.call.session] ?? props.record.manifest.deliveredInputs?.[props.call.session] ?? []} />
<Let as="references" value={[...new Set([...props.record.manifest.acceptedInputs.map(input => input.path),...(props.record.manifest.roleInputs?.[props.call.role] ?? []).map(input => input.path),...(props.call.assignment.handoffInputs ?? [])])].filter(path => !received.includes(path))} />
<Ticket.Documents repository={props.call.assignment.repository} paths={references} documents={props.record.documents} as="documents" />
<Let as="inputs" value={references.map(path => documents[path])} />
<If condition={inputs.reduce((total,input) => total + input.content.length,0) > 64000}>
<Fail message="Selected handoff inputs exceed 64000 characters. Return a concise handoff document and preserve full logs as artifacts; nothing was truncated or dispatched." />
</If>
<Return value={{documents,inputs,deliveredInputs:{...(props.record.manifest.deliveredInputs ?? {}),...(props.record.deliveredInputs ?? {}),[props.call.session]:[...new Set([...received,...references])]}}} />
