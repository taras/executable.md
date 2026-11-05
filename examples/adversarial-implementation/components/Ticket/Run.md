---
description: >-
  Carry ordinary planning or accepted implementation through its original roles. Use <Ticket.Run
  manifest="/private/tmp/ticket-manifest.json" as="ticket" />. Reopen the same unfinished
  REPL entry to resume; failures and unanswered decisions hold the ticket.
props:
  type: object
  properties:
    manifest: {type: string, minLength: 1}
    plannerCall: {type: [string, 'null'], default: null}
    maxSteps: {type: integer, minimum: 1}
  required: [manifest]
  additionalProperties: false
returns: {type: object}
---

One REPL drives this ticket. Each phase returns the next state to this loop.
XMD reconstructs these bindings when it replays the same execution, using its
completed operation results. The artifact directory preserves evidence rather
than a second checkpoint journal.

<Ticket.Read path={props.manifest} limit={1048576} as="manifestText" />
<Parse schema={{type:"object"}} as="manifest">{manifestText}</Parse>
<If condition={manifest.directory === undefined}>
<If condition={typeof manifest.work !== "string" || !/^[A-Za-z0-9_-]+$/.test(manifest.work)}><Fail message="Use a ticket slug for workspace handoffs, or supply the existing recorded directory explicitly." /></If>
```bash exec as="workspace"
pwd -P
```
<If condition={workspace.exitCode !== 0}><Fail message={JSON.stringify(workspace)} /></If>
<Let as="manifest" value={{...manifest,directory:workspace.stdout.slice(0,-1) + "/handoffs/" + manifest.work}} />
</If>
<Ticket.Start manifest={manifest} as="checkpoint" />
<Let as="checkpoint" value={{...checkpoint,plannerCall:props.plannerCall}} />
<Let as="documents" value={{}} />
<Let as="originals" value={[...manifest.acceptedInputs,...Object.values(manifest.roleInputs ?? {}).flat()]} />
<Let as="references" value={originals.map(input => input.path)} />
<Ticket.DocumentCapacity directory={manifest.directory} as="documentsFit" />
<If condition={!documentsFit}><Return value={{status:"hold",reason:"Initial document metadata exceeds continuation capacity; no text was retained or role dispatched."}} /><Else>
<Let as="index" value={0} />
<Loop max={originals.length}>
<Let as="input" value={originals[index]} />
<If condition={!Object.hasOwn(documents,input.path)}>
<Ticket.Snapshot repository={manifest.assignment.repository} directory={manifest.directory} path={input.path} content={input.content} as="saved" />
<Let as="documents" value={{...documents,[input.path]:saved}} />
</If>
<Let as="index" value={index + 1} />
</Loop>
<Let as="manifest" value={{...manifest,acceptedInputs:manifest.acceptedInputs.map(input => documents[input.path]),roleInputs:Object.fromEntries(Object.entries(manifest.roleInputs ?? {}).map(([role,inputs]) => [role,inputs.map(input => documents[input.path])]))}} />
<Let as="record" value={{schema:"ticket-state.v1",manifest,checkpoint,calls:[],documents,deliveredInputs:manifest.deliveredInputs ?? {}}} />
<Let as="attemptsDirectory" value={"'" + (manifest.directory + "/attempts").replaceAll("'", "'\"'\"'") + "'"} />
<Let as="callsDirectory" value={"'" + (manifest.directory + "/calls").replaceAll("'", "'\"'\"'") + "'"} />
```bash exec as="prepared"
mkdir -p -- {attemptsDirectory} {callsDirectory}
```
<If condition={prepared.exitCode !== 0}><Fail message={prepared.stderr || prepared.stdout} /></If>
<Ticket.Capacity name="record" as="fits" />
<If condition={!fits}><Return value={{status:"hold",reason:"Initial continuation capacity exceeded; no role was dispatched."}} /><Else>
<Ticket.Publish record={record} as="confirmed" />
<If condition={confirmed.publication === "confirmed"}>
<Ticket.Walk record={record} confirmed={confirmed} maxSteps={props.maxSteps} as="continued" />
<Return value={continued} />
<Else><Return value={confirmed} /></Else></If>
</Else></If>

</Else></If>
