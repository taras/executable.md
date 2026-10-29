---
description: >-
  Continue an accepted implementation through its selected original reviewers. Use <Ticket.Run
  manifest="/private/tmp/ticket-manifest.json" as="ticket" />. Reopen the same unfinished
  REPL entry to resume; failures and unanswered decisions hold the ticket.
props:
  type: object
  properties:
    manifest: {type: string, minLength: 1}
  required: [manifest]
  additionalProperties: false
returns: {type: object}
---

One REPL drives this ticket. Each phase returns the next state to this loop.
XMD reconstructs these bindings when it replays the same execution, using its
completed operation results. The artifact directory preserves evidence rather
than a second checkpoint journal.

<Ticket.Text path={props.manifest} as="manifestText" />
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
<Let as="record" value={{manifest,checkpoint,calls:[],documents:Object.fromEntries([...manifest.acceptedInputs,...Object.values(manifest.roleInputs ?? {}).flat()].map(input => [input.path,input]))}} />
<Let as="attemptsDirectory" value={"'" + (manifest.directory + "/attempts").replaceAll("'", "'\"'\"'") + "'"} />
<Let as="callsDirectory" value={"'" + (manifest.directory + "/calls").replaceAll("'", "'\"'\"'") + "'"} />
```bash exec as="prepared"
mkdir -p -- {attemptsDirectory} {callsDirectory}
```
<If condition={prepared.exitCode !== 0}><Fail message={prepared.stderr || prepared.stdout} /></If>
<Ticket.Continue record={record} as="record" />
<Return value={{...record,...record.checkpoint}} />
