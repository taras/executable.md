---
props:
  type: object
  properties:
    record: {type: string}
  required: [record]
  additionalProperties: false
---

<Ticket.Text path={props.record} as="text" />
<Parse schema={{type:"object"}} as="manifest">{text}</Parse>
<Ticket.Start manifest={manifest} as="checkpoint" />
<Let as="documents" value={{}} />
<Let as="index" value={0} /><Loop max={manifest.acceptedInputs.length}><Let as="input" value={manifest.acceptedInputs[index]} />
<Ticket.Snapshot repository={manifest.assignment.repository} directory={manifest.directory} path={input.path} content={input.content} as="saved" />
<Let as="documents" value={{...documents,[input.path]:saved}} />
<Let as="index" value={index + 1} /></Loop>
<Let as="manifest" value={{...manifest,acceptedInputs:manifest.acceptedInputs.map(input => documents[input.path])}} />
<Let as="record" value={{schema:"ticket-state.v1",manifest,checkpoint:{...checkpoint,round:2},calls:[],documents,deliveredInputs:manifest.deliveredInputs ?? {}}} />
<Dir path={manifest.directory + "/attempts"}><Let as="prepared" value={true} /></Dir>
<Dir path={manifest.directory + "/calls"}><Let as="prepared" value={true} /></Dir>
<Ticket.Publish record={record} as="confirmed" /><Ticket.Walk record={record} confirmed={confirmed} maxSteps={1} as="continued" />
<Output><Json value={continued} /></Output>
