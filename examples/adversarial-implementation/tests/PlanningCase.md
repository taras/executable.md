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
<Let as="record" value={{manifest,checkpoint:{...checkpoint,round:2},calls:[],documents:Object.fromEntries(manifest.acceptedInputs.map(input => [input.path,input]))}} />
<Dir path={manifest.directory + "/attempts"}><Let as="prepared" value={true} /></Dir>
<Dir path={manifest.directory + "/calls"}><Let as="prepared" value={true} /></Dir>
<Ticket.Step record={record} as="record" />
<Output><Json value={record} /></Output>
