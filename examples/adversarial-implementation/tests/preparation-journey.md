---
props:
  type: object
  properties:
    manifest: {type: string}
    identity: {type: boolean, default: false}
  required: [manifest]
---
<Ticket.Read path={props.manifest} limit={1048576} as="text" />
<Parse schema={{type:"object"}} as="manifest">{text}</Parse>
<Ticket.Run manifest={props.manifest} maxSteps={3} as="plannedReturn" />
<Ticket.Load record={plannedReturn} as="planned" />
<If condition={planned.calls.length !== 3}><Fail message={JSON.stringify({calls:planned.calls.map(call => ({id:call.id,status:call.status})),hold:planned.checkpoint.hold})} /></If>
<Ticket.Gate record={planned} as="selected" />
<Ticket.Inputs record={planned} call={selected.call} inspect={true} as="overage" />
<Ticket.Capture as="failure"><Ticket.Inputs record={planned} call={selected.call} as="unexpected" /></Ticket.Capture>
<Ticket.Fingerprint inputs={overage.inputs} as="firstHashes" />
<Dir path={manifest.directory}><File path="first-overage.json"><Json value={{...failure,budget:overage.budget,hashes:firstHashes}} /></File></Dir>
<Let as="originalPaths" value={planned.calls.flatMap(call => [call.attempt+"/raw.txt",call.attempt+"/result.json"])} />
<Ticket.Documents repository={manifest.assignment.repository} directory={manifest.directory + "/journey-before"} paths={originalPaths} as="originals" />
<Let as="removed" value={overage.inputs.map(input => input.path).filter(path => !overage.mandatoryPaths.includes(path))} />
<Let as="quotedRemoved" value={removed.map(path => "'" + path.replaceAll("'","'\"'\"'") + "'").join(" ")} />
```bash exec as="mutated"
set -eu
for path in {quotedRemoved}; do printf 'MUTATED AFTER CAPTURE' > "$path"; rm -- "$path"; done
for path in {quotedRemoved}; do test ! -e "$path"; done
```
<If condition={mutated.exitCode !== 0}><Fail message={mutated.stderr} /></If>
<Let as="identityPath" value={(manifest.identityDirectory ?? manifest.directory + "/sessions") + "/" + encodeURIComponent(planned.manifest.roles.planner.session) + ".json"} />
<Let as="identityBefore" value={null} />
<If condition={props.identity}>
<Ticket.Read path={identityPath} limit={1048576} as="identityText" />
<Parse schema={{type:"object"}} as="identityReceipt">{identityText}</Parse>
<Let as="identityBefore" value={{...identityReceipt,identity:{...identityReceipt.identity,kind:"substituted." + identityReceipt.identity.kind}}} />
<Dir path={identityPath.slice(0,identityPath.lastIndexOf("/"))}><File path={identityPath.slice(identityPath.lastIndexOf("/") + 1)}><Json value={identityBefore} /></File></Dir>
</If>
<Ticket.Continue record={plannedReturn} maxSteps={1} as="continuedReturn" />
<Ticket.Load record={continuedReturn} as="continued" />
<Ticket.Documents repository={manifest.assignment.repository} directory={manifest.directory + "/journey-after"} paths={originalPaths} as="afterOriginals" />
<Let as="identityAfter" value={null} />
<If condition={props.identity}>
<Ticket.Read path={identityPath} limit={1048576} as="identityText" />
<Parse schema={{type:"object"}} as="identityAfter">{identityText}</Parse>
</If>
<Output><Json value={{planned,continued,plannedReturn,continuedReturn,removed,budget:overage.budget,firstFailure:failure.status,firstHashes,originalsPreserved:JSON.stringify(Object.values(originals).map(document => document.sha256)) === JSON.stringify(Object.values(afterOriginals).map(document => document.sha256)),identityPath,identityPreserved:JSON.stringify(identityBefore) === JSON.stringify(identityAfter)}} /></Output>
