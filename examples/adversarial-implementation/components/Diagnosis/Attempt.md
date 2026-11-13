---
description: 'Record a read-only diagnostic turn for an assigned revision. Use <Diagnosis.Attempt request={request} directory={directory} position={0} inputs={inputs} namespace={namespace} as="attempt" />.'
props:
  type: object
  properties:
    request: {type: object}
    directory: {type: string, pattern: '^/'}
    position: {enum: [0, 1]}
    inputs: {type: array}
    previous: {type: [object, 'null'], default: null}
    namespace: {type: object}
    previousModel: {type: [string, 'null'], default: null}
  required: [request, directory, position, inputs, namespace]
  additionalProperties: false
returns: {type: object}
---

<Let as="request" value={props.request} />
<Let as="assignment" value={request.assignment} />
<Let as="solver" value={props.position === 0 ? {provider:"claude",model:"fable",effort:"high",session:props.namespace.name+"-fable"} : {provider:"codex",model:"gpt-6-astra",effort:"high",session:props.namespace.name+"-astra"}} />
<Let as="identities" value={props.namespace.identities} />
<If condition={props.previous !== null && (props.previous.solver.provider !== solver.provider || props.previous.solver.model !== solver.model || props.previous.solver.effort !== solver.effort || props.previous.solver.session !== solver.session)}><Fail message="The continuation must use the original solver and session." /></If>
<Ticket.Fingerprint inputs={props.inputs} as="evidence" />
<Let as="record" value={{schema:"diagnosis-attempt.v1",assignment,primarySession:request.session,position:props.position,solver,identities,previous:request.previous ?? null,evidence}} />
<Dir path={props.directory}><File path="assignment.json"><Json value={record} /></File><File path="inputs.json"><Json value={props.inputs} /></File></Dir>
<Diagnosis.Schema as="schema" />
<Let as="submission">
# Submit a diagnosis result

Read this when preparing the final diagnosis, including a missing-witness result.

For a confirmed cause, cite the captured evidence that distinguishes it. Give a
regression command, its expected and observed behavior, and a bounded Opus
handoff. If the evidence leaves multiple causes possible, name the specific
missing witness and how to obtain it.

Return one JSON object. Keep any progress updates in plain prose.

<Json value={schema.result} />
</Let>
<Phase.SubmissionGuide repository={assignment.repository} directory={props.directory} as="guide">{submission}</Phase.SubmissionGuide>
<Let as="instructions">
Diagnose the failure using the assigned checkout at {assignment.revision}. Read the repository instructions. Use the captured evidence and reuse the listed probes where they address the missing witness. Run focused commands in owned scratch space and join them before replying. Keep source, workflow records, and external systems read-only.

<If condition={assignment.spec !== undefined}>Read the owning spec section at {assignment.spec}.</If>
<If condition={assignment.failingRevision !== undefined}>Failing CI revision: {assignment.failingRevision}. Compare the relevant paths with the assigned checkout before attributing the failure.</If>
<If condition={assignment.probes?.length > 0}>
Reusable probes:
<Json value={assignment.probes} />
</If>

{assignment.request}

Report a confirmed cause with supporting evidence or the specific missing witness. Read {guide.path} when preparing that result. Open it earlier only if a reporting requirement affects a concrete diagnostic decision. Keep progress updates in plain prose.
</Let>
<Let as="evidence">
Captured evidence:
<Json value={props.inputs} />
</Let>
<Let as="evidenceReference">
Read the captured evidence in {props.directory}/inputs.json. Each entry contains the original path and its captured content. Start with the paths relevant to the failure and inspect one entry at a time. Cite the original paths in your result.
</Let>
<Let as="prompt" value={instructions + "\n\n" + evidence} />
<If condition={prompt.length > 64000}>
<Let as="prompt" value={instructions + "\n\n" + evidenceReference} />
</If>
<If condition={prompt.length > 64000}><Fail message="The diagnostic assignment exceeds 64000 characters with evidence supplied by reference. Shorten the assignment in a fresh attempt." /></If>
<Let as="catalog" value={null} />
<Let as="turn" value={null} />
<Ticket.Checkout repository={assignment.repository} as="before" />
<If condition={before.head !== assignment.revision || !before.clean}><Fail message="The diagnostic checkout must be clean and at the assigned revision before prompting." /></If>
<Dir path={assignment.repository}>
<AgentProvider name="diagnostic-acpx" defaultAgent={solver.provider}>
<Delivery.Inspect agent={solver.provider} choices={props.previous === null && props.position === 0 ? [solver.model,"claude-fable-5-1[1m]"] : [props.previousModel ?? solver.model]} as="catalog" />
<Try>
<If condition={catalog.state === "selected"}>
<Delivery.Turn as="turn">
<Agent name={solver.provider}><Session name={solver.session} model={catalog.model} effort={solver.effort}><Phase.Session directory={identities} name={solver.session} requireExisting={props.previous !== null}><Prompt timeout="30m" throwOnError={true}>{prompt}</Prompt></Phase.Session></Session></Agent>
</Delivery.Turn>
</If>
<Finally><Dir path={props.directory}><File path="outcome.json"><Json value={{catalog,turn}} /></File></Dir></Finally>
</Try>
<If condition={turn?.state === "reply"}><Dir path={props.directory}><File path="raw.txt">{turn.reply}</File></Dir></If>
</AgentProvider>
</Dir>
<Ticket.Checkout repository={assignment.repository} as="after" />
<If condition={after.head !== assignment.revision || !after.clean}><Fail message="The diagnostic checkout changed. Preserve the attempt for reconciliation." /></If>
<If condition={turn?.state === "reply"}>
<Phase.SubmissionGuide repository={assignment.repository} directory={props.directory} mode="check">{submission}</Phase.SubmissionGuide>
</If>
<Return value={{record,catalog,turn}} />
