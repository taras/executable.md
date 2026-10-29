---
props:
  type: object
  properties:
    assignment: {type: object}
    role: {enum: [architect, planner, implementor]}
    session: {type: string}
    attempt: {type: string}
    raw: {type: string}
    profile: {type: object}
    implementationProvider: {enum: [claude, codex]}
    inputs: {type: array, items: {type: object}}
  required: [assignment, role, session, attempt, raw, profile, implementationProvider, inputs]
  additionalProperties: false
returns: {type: object}
---

<Phase.Schema as="schemas" />
<Phase.Profile role={props.role} assessment={props.assignment.assessment} implementationProvider={props.implementationProvider} as="roleProfile" />
<Let as="raw" value={props.raw} />
<Let as="rawPath" value={props.attempt + "/raw.txt"} />
<Let as="round" value={0} />
<Let as="diagnostics" value={[]} />
<Phase.Response assignment={props.assignment} text={raw} role={props.role} profile={props.profile} as="checked" />
<Let as="established" value={null} />
<If condition={!checked.ok}>
<Dir path={props.attempt}><File path="response-rejection-0000.json"><Json value={checked.rejection} /></File></Dir>
<Let as="diagnostics" value={[props.attempt + "/response-rejection-0000.json"]} />
<If condition={props.profile.establishedPath !== undefined}>
<Ticket.Text path={props.profile.establishedPath} as="establishedText" />
<Parse schema={schemas.result} as="established">{establishedText}</Parse>
<Else>
<Phase.Extract text={raw} as="extracted" />
<If condition={extracted.ok}>
<SafeParse schema={{type:"object",properties:{outcome:{enum:["complete","pass","changes_required","missing_evidence","needs_discovery","needs_decision","blocked"]},revision:{type:["string","null"]},summary:{type:"string",minLength:1},artifacts:{type:"array",items:{type:"string"}},evidence:{type:"array"},findings:{type:"array"}},required:["outcome","revision","summary","artifacts","evidence","findings"]}} as="recoverable">{extracted.json}</SafeParse>
<If condition={recoverable.ok}>
<Phase.Revisions repository={props.assignment.repository} value={recoverable.value} as="canonical" />
<If condition={canonical.ok}><Let as="established" value={canonical.value} /></If>
</If>
</If>
</Else>
</If>
<If condition={props.profile.kind === "delivery-editorial" && established?.outcome === "pass"}>
<If condition={props.profile.appliedPath === undefined}><Fail message="Applied text has no established receipt; response correction cannot repeat APPLY." /></If>
<Ticket.Text path={props.profile.appliedPath} as="appliedText" />
<Parse schema={{type:"object",properties:{title:{type:"string"},body:{type:"string"}},required:["title","body"],additionalProperties:false}} as="applied">{appliedText}</Parse>
</If>
<Ticket.Capture as="assessmentValidation">
<If condition={established?.assessment}>
<ReviewPolicy assessment={established.assessment} kind={props.assignment.reviewKind ?? "feature"} as="establishedPolicy" />
<Json value={true} />
<Else><Fail message="No valid assessment was established." /></Else>
</If>
</Ticket.Capture>
<Let as="frozen" value={established === null ? null : {...(established.exactCorrection === undefined ? {} : {exactCorrection:established.exactCorrection}),assessment:assessmentValidation.status === "completed" ? established.assessment : null,outcome:established.outcome,revision:established.revision,summary:established.summary,artifacts:established.artifacts,evidence:established.evidence,findings:established.findings,blocker:established.blocker ?? null,contract:props.role === "architect" && props.assignment.phase === "discovery" ? established.contract ?? null : null,discoveryRequests:(established.discoveryRequests ?? []).filter(request => request.role === props.role),discoveryGaps:(established.discoveryGaps ?? []).filter(gap => gap.request.role === props.role)}} />
<Loop max={3}>
<If condition={checked.ok}><Break /></If>
<If condition={checked.rejection.terminal || frozen === null}><Break /></If>
<Let as="round" value={round + 1} />
<Let as="directory" value={props.attempt + "/response-corrections/" + String(round).padStart(4,"0")} />
<Dir path={props.attempt + "/response-corrections"}><Let as="parentPrepared" value={true} /></Dir>
<Let as="quoted" value={"'" + directory.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="reserved"
mkdir -- {quoted}
```
<If condition={reserved.exitCode !== 0}><Fail message="A correction reservation is occupied or uncertain; preserve it and reconcile without another prompt." /></If>
<Let as="packet" value={{schema:"phase-response-correction.v1",role:props.role,session:props.session,provider:roleProfile.provider,initialize:false,phase:props.assignment.phase,work:props.assignment.work,revision:props.assignment.revision,assignment:props.attempt + "/assignment.json",ordinal:round,remaining:3-round,raw:rawPath,rejectedText:raw,rejection:checked.rejection,resultSchema:schemas.result,profile:props.profile,established:frozen,report:props.profile.establishedPath ?? null,applied:props.profile.kind === "delivery-editorial" && established?.outcome === "pass" ? applied : null,references:[...new Set([...(props.assignment.artifacts ?? []),...props.inputs.map(input => input.path)])],permitted:"Only rejected syntax/schema/identity/routing/handoff/provenance metadata and an assessment that was missing or invalid; preserve any valid established assessment, substantive outcome, source and genuine evidence. Other owners' gaps stay referenced, not redeclared."}} />
<If condition={JSON.stringify(packet).length > 64000}><Fail message="The correction packet exceeds 64000 characters; preserve the missing delivery fact without truncation or dispatch." /></If>
<Dir path={directory}><File path="request.json"><Json value={packet} /></File><File path="diagnostic.json"><Json value={checked.rejection} /></File><File path="original-inputs.json"><Json value={props.inputs} /></File></Dir>
<Let as="quotedAssignment" value={"'" + (props.attempt + "/assignment.json").replaceAll("'","'\"'\"'") + "'"} />
<Let as="quotedRaw" value={"'" + rawPath.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="identities"
shasum -a 256 -- {quoted}/request.json {quoted}/diagnostic.json {quoted}/original-inputs.json {quotedAssignment} {quotedRaw}
```
<If condition={identities.exitCode !== 0}><Fail message="Correction input identities were not established; no correction prompt is admitted." /></If>
<Dir path={directory}><File path="input-identities.sha256">{identities.stdout}</File></Dir>
<Phase.Role role={props.role} session={props.session} assignment={props.assignment} initialize={false} implementationProvider={props.implementationProvider} inputs={[]} correction={packet} as="raw" />
<Let as="rawPath" value={directory + "/raw.txt"} />
<Dir path={directory}><File path="raw.txt">{raw}</File></Dir>
<Phase.Response assignment={props.assignment} text={raw} role={props.role} profile={props.profile} as="checked" />
<If condition={checked.ok}>
<Phase.Correspondence established={frozen} value={checked.value} role={props.role} phase={props.assignment.phase} as="correspondence" />
<If condition={!correspondence.ok}>
<Let as="checked" value={{ok:false,rejection:{kind:"response_validation",code:"substantive-correspondence",message:"Response-only correction changed established substantive outcome, source or evidence.",issues:[]}}} />
</If>
</If>
<If condition={checked.ok && props.profile.kind === "delivery-editorial" && checked.value.outcome === "pass" && JSON.stringify(checked.value.metadata) !== JSON.stringify(applied)}>
<Let as="checked" value={{ok:false,rejection:{kind:"response_validation",code:"applied-text",message:"The response does not name the exact already applied title/body.",issues:[]}}} />
</If>
<Dir path={directory}><File path="disposition.json"><Json value={{ordinal:round,accepted:checked.ok,rejection:checked.ok ? null : checked.rejection,raw:rawPath,deliveryIdentity:directory + "/request.json",originalInputsRepeated:false}} /></File></Dir>
<If condition={!checked.ok}><Let as="diagnostics" value={[...diagnostics,directory + "/disposition.json"]} /></If>
</Loop>
<If condition={!checked.ok}>
<Let as="code" value={round === 3 ? "response_correction_exhausted" : "response_correction_unestablished"} />
<Dir path={props.attempt}><File path="response-disposition.json"><Json value={{status:"failed_without_result",dispatchable:false,code,consumed:round,limit:3,diagnostics,lastRejection:checked.rejection,substantiveEstablished:frozen !== null}} /></File></Dir>
<Fail message={code + ": " + round + " corrections consumed; no canonical result or successor. Inspect " + props.attempt + "/response-disposition.json"} />
</If>
</If>
<Phase.Accept assignment={props.assignment} role={props.role} profile={props.profile} text={raw} as="result" />
<Return value={{result,round,rawPath,diagnostics,normalizations:checked.normalizations ?? []}} />
