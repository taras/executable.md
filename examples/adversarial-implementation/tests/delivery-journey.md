---
props:
  type: object
  properties:
    manifest: {type: string}
  required: [manifest]
---
<Ticket.Text path={props.manifest} as="text" />
<Parse schema={{type:"object"}} as="manifest">{text}</Parse>
<Ticket.Start manifest={manifest} as="checkpoint" />
<Let as="record" value={{manifest,checkpoint,calls:[],documents:Object.fromEntries(manifest.acceptedInputs.map(input => [input.path,input])),deliveredInputs:manifest.deliveredInputs ?? {}}} />
<Dir path={manifest.directory+"/calls"}><Let as="callsPrepared" value={true} /></Dir>
<Ticket.Continue record={record} maxSteps={1} as="first" />
<Ticket.Continue record={first} maxSteps={1} as="again" />
<Output><Json value={{first,again}} /></Output>
