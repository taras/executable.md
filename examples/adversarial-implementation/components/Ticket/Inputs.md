---
description: >-
  Inspect or admit the documents selected for this retained role. Use
  <Ticket.Inputs record={record} call={call} as="prepared" /> before dispatch.
props:
  type: object
  properties:
    record: {type: object}
    call: {type: object}
    inspect: {type: boolean, default: false}
  required: [record, call]
  additionalProperties: false
returns: {type: object}
---

Accepted inputs are supplied once to each original session. A returned
handoff selects additional documents explicitly. Artifact and log references
remain available without adding their contents to the prompt. Inspection reports the
actual total, undelivered mandatory floor and remaining allowance without refusing
an overage. The returned deliveryProposal is not evidence of delivery; its owner
promotes it only after saving a successful raw reply.

<Let as="received" value={props.record.deliveredInputs?.[props.call.session] ?? props.record.manifest.deliveredInputs?.[props.call.session] ?? []} />
<Let as="references" value={[...new Set([...props.record.manifest.acceptedInputs.map(input => input.path),...(props.record.manifest.roleInputs?.[props.call.role] ?? []).map(input => input.path),...(props.call.assignment.handoffInputs ?? [])])].filter(path => !received.includes(path))} />
<Ticket.Documents repository={props.call.assignment.repository} directory={props.record.manifest.directory} paths={references} documents={props.record.documents} as="documents" />
<Let as="inputs" value={[]} />
<Let as="index" value={0} />
<If condition={references.length !== 0}>
<Loop max={references.length}>
<Let as="reference" value={references[index]} />
<Ticket.Hydrate repository={props.call.assignment.repository} document={documents[reference]} as="hydrated" />
<Let as="inputs" value={[...inputs,hydrated]} />
<Let as="index" value={index + 1} />
</Loop>
</If>
<Let as="mandatoryPaths" value={[...new Set([...props.record.manifest.acceptedInputs.map(input => input.path),...(props.record.manifest.roleInputs?.[props.call.role] ?? []).map(input => input.path)])].filter(path => !received.includes(path))} />
<Let as="mandatory" value={inputs.filter(input => mandatoryPaths.includes(input.path)).reduce((total,input) => total + input.content.length,0)} />
<Let as="total" value={inputs.reduce((total,input) => total + input.content.length,0)} />
<Let as="budget" value={{limit:64000,total,mandatory,remaining:64000-mandatory,excess:Math.max(0,total-64000),admitted:total<=64000}} />
<If condition={!props.inspect && !budget.admitted}>
<Fail message={"Selected handoff inputs total " + total + " characters, exceeding 64000. Selected references and sizes: " + inputs.map(input => input.path + " (" + input.content.length + ")").join(", ") + ". Return concise handoff documents; preserve full logs as artifacts. No provider prompt began."} />
</If>
<Return value={{documents,inputs,budget,mandatoryPaths,received,deliveryProposal:{...(props.record.manifest.deliveredInputs ?? {}),...(props.record.deliveredInputs ?? {}),[props.call.session]:[...new Set([...received,...references])]}}} />
