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
<Let as="prompt">
Diagnose the failure at {assignment.revision}. Read the repository instructions. Use the captured evidence and run focused probes in owned scratch space. Join every process you start before replying. Leave source, workflow records, and external systems unchanged.

{assignment.request}

Captured evidence:
<Json value={props.inputs} />

For a confirmed cause, explain which captured observations distinguish it, cite their paths, describe the regression command with the observed and expected behavior, and give Opus the bounded implementation handoff. When the evidence cannot distinguish the cause, give the specific missing witness and how to obtain it.
Use this JSON schema.
<Json value={schema.result} />

Reply with only the JSON object. Start with an opening brace and end with a closing brace. Omit Markdown fences and any text before or after the object.
</Let>
<If condition={prompt.length > 64000}><Fail message="The diagnostic prompt exceeds 64000 characters. Prepare concise evidence in a fresh attempt." /></If>
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
<Agent name={solver.provider}><Session name={solver.session} model={catalog.model} effort={solver.effort}><Phase.Session directory={identities} name={solver.session} requireExisting={props.previous !== null}><Prompt timeout="10m" throwOnError={true}>{prompt}</Prompt></Phase.Session></Session></Agent>
</Delivery.Turn>
</If>
<Finally><Dir path={props.directory}><File path="outcome.json"><Json value={{catalog,turn}} /></File></Dir></Finally>
</Try>
<If condition={turn?.state === "reply"}><Dir path={props.directory}><File path="raw.txt">{turn.reply}</File></Dir></If>
</AgentProvider>
</Dir>
<Ticket.Checkout repository={assignment.repository} as="after" />
<If condition={after.head !== assignment.revision || !after.clean}><Fail message="The diagnostic checkout changed. Preserve the attempt for reconciliation." /></If>
<Return value={{record,catalog,turn}} />
