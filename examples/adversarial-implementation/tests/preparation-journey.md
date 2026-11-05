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
<Let as="record" value={{manifest,checkpoint,calls:[],documents:Object.fromEntries([...manifest.acceptedInputs,...Object.values(manifest.roleInputs ?? {}).flat()].map(input => [input.path,input]))}} />
<Dir path={manifest.directory+"/calls"}><Let as="callsPrepared" value={true} /></Dir>
<Ticket.Continue record={record} maxSteps={3} as="planned" />
<If condition={planned.calls.length !== 3}><Fail message={JSON.stringify({calls:planned.calls.map(call => ({id:call.id,status:call.status})),hold:planned.hold})} /></If>
<Ticket.Gate record={planned} as="selected" />
<Ticket.Inputs record={planned} call={selected.call} inspect={true} as="overage" />
<Ticket.Capture as="failure"><Ticket.Inputs record={planned} call={selected.call} as="unexpected" /></Ticket.Capture>
<Ticket.Fingerprint inputs={overage.inputs} as="firstHashes" />
<Dir path={manifest.directory}><File path="first-overage.json"><Json value={{...failure,budget:overage.budget,inputs:overage.inputs,hashes:firstHashes}} /></File></Dir>
<Let as="originalPaths" value={planned.calls.flatMap(call => [call.attempt+"/raw.txt",call.attempt+"/result.json"])} />
<Ticket.Documents repository={manifest.assignment.repository} paths={originalPaths} as="originals" />
<Ticket.Fingerprint inputs={Object.values(originals)} as="beforePlanning" />
<Ticket.Continue record={planned} maxSteps={1} as="continued" />
<Ticket.Documents repository={manifest.assignment.repository} paths={originalPaths} as="afterOriginals" />
<Ticket.Fingerprint inputs={Object.values(afterOriginals)} as="afterPlanning" />
<Output><Json value={{planned,continued,budget:overage.budget,firstFailure:failure.status,firstHashes,originalsPreserved:JSON.stringify(beforePlanning) === JSON.stringify(afterPlanning)}} /></Output>
