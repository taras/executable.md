---
description: 'Validate a saved foundation reply and bound response-only corrections in its original session. Use <Adversarial.Response assignment={assignment} raw={raw} as="accepted" />.'
props:
  type: object
  properties:
    assignment: {type: object}
    raw: {type: string}
  required: [assignment, raw]
  additionalProperties: false
returns: {type: object}
---

<Adversarial.Schema as="schemas" />
<Let as="raw" value={props.raw} />
<Let as="rawPath" value={props.assignment.attempt + "/raw.txt"} />
<Let as="round" value={0} />
<Phase.Extract text={raw} as="extracted" />
<If condition={!extracted.ok}>
<Dir path={props.assignment.attempt}><File path="response-rejection-0000.json"><Json value={extracted} /></File></Dir>
<Fail message="No unambiguous substantive foundation result is established. Preserve raw.txt and response-rejection-0000.json; no productive prompt is repeated." />
</If>
<SafeParse schema={schemas.foundation} as="checked">{extracted.json}</SafeParse>
<If condition={!checked.ok}>
<Dir path={props.assignment.attempt}><File path="response-rejection-0000.json"><Json value={checked} /></File></Dir>
<Let as="relaxed" value={{...schemas.foundation,properties:{...schemas.foundation.properties,summary:{type:"string",minLength:1},handoff:{type:"string",minLength:1}}}} />
<SafeParse schema={relaxed} as="established">{extracted.json}</SafeParse>
<If condition={!established.ok}><Fail message="No unambiguous substantive foundation result is established. Preserve raw.txt and response-rejection-0000.json; no productive prompt is repeated." /></If>
<Let as="frozen" value={{...schemas.foundation,properties:Object.fromEntries(Object.entries(schemas.foundation.properties).map(([key,schema]) => [key,(key === "summary" || key === "handoff") && established.value[key].length > schema.maxLength ? schema : {const:established.value[key]}]))}} />
<Loop max={3}>
<If condition={checked.ok}><Break /></If>
<Let as="round" value={round + 1} />
<Let as="directory" value={props.assignment.attempt + "/response-corrections/" + round} />
<Dir path={props.assignment.attempt + "/response-corrections"}><Let as="parentPrepared" value={true} /></Dir>
<Let as="quoted" value={"'" + directory.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="reserved"
mkdir -- {quoted}
```
<If condition={reserved.exitCode !== 0}><Fail message="Preserve the occupied response correction; do not repeat its prompt." /></If>
<Let as="packet" value={{ordinal:round,remaining:3-round,raw:rawPath,rejection:checked.errors,established:established.value,resultSchema:frozen}} />
<If condition={JSON.stringify(packet).length > 64000}><Fail message="The response correction packet exceeds its input bound; preserve it without dispatch." /></If>
<Dir path={directory}><File path="request.json"><Json value={packet} /></File></Dir>
<Ticket.Checkout repository={props.assignment.repository} as="before" />
<If condition={!before.clean || before.head !== established.value.revision}><Fail message="Reconcile source before response-only correction." /></If>
<Dir path={props.assignment.repository}>
```bash exec as="statusBefore"
git status --porcelain=v1 --untracked-files=all
```
</Dir>
<If condition={statusBefore.exitCode !== 0 || statusBefore.stdout !== ""}><Fail message="Reconcile tracked and untracked source before response-only correction." /></If>
<Dir path={directory}><File path="source-before.json"><Json value={statusBefore} /></File></Dir>
<Dir path={props.assignment.repository}><Adversarial.PlannerRole assignment={{...props.assignment,initialize:false}} guide="" correction={packet} as="raw" /></Dir>
<Let as="rawPath" value={directory + "/raw.txt"} />
<Dir path={directory}><File path="raw.txt">{raw}</File></Dir>
<Ticket.Checkout repository={props.assignment.repository} as="after" />
<Dir path={props.assignment.repository}>
```bash exec as="statusAfter"
git status --porcelain=v1 --untracked-files=all
```
</Dir>
<Dir path={directory}><File path="source-after.json"><Json value={statusAfter} /></File></Dir>
<If condition={!after.clean || after.head !== before.head || statusAfter.exitCode !== 0 || statusAfter.stdout !== statusBefore.stdout}><Fail message="Response-only correction changed source. Preserve its effects and hold." /></If>
<Phase.Extract text={raw} as="extracted" />
<Let as="checked" value={{ok:false,input:raw,errors:extracted.ok ? [] : [extracted.rejection]}} />
<If condition={extracted.ok}><SafeParse schema={frozen} as="checked">{extracted.json}</SafeParse></If>
<Dir path={directory}><File path="disposition.json"><Json value={{round,accepted:checked.ok,raw:rawPath,errors:checked.ok ? [] : checked.errors}} /></File></Dir>
</Loop>
<If condition={!checked.ok}><Fail message="Three response-only corrections are exhausted. Preserve their receipts; no productive prompt is repeated." /></If>
</If>
<Return value={{result:checked.value,round,rawPath}} />
