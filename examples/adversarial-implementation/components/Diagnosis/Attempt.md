---
props:
  type: object
  properties:
    request: {type: object}
    call: {type: object}
    inputs: {type: array}
  required: [request, call, inputs]
  additionalProperties: false
returns: {type: object}
---

<Let as="request" value={props.request} />
<Let as="assignment" value={request.assignment} />
<Let as="call" value={props.call} />
<Let as="solver" value={call.solver} />
<Let as="identities" value={call.identities} />
<Ticket.Fingerprint inputs={props.inputs} as="evidence" />
<Let as="record" value={{schema:"diagnosis-attempt.v1",assignment,primarySession:request.session,position:call.position,solver,solverKey:call.solverKey,identities,previous:request.previous ?? null,evidence}} />
<Dir path={call.directory}><File path="assignment.json"><Json value={record} /></File><File path="inputs.json"><Json value={props.inputs} /></File></Dir>
<Let as="materialText"><Content /></Let>
<Parse schema={{type:"object",properties:{submission:{type:"string"},instructions:{type:"string"}},required:["submission","instructions"]}} as="material">{materialText}</Parse>
<Let as="submission" value={material.submission} />
<Phase.SubmissionGuide repository={assignment.repository} directory={call.directory} as="guide">{submission}</Phase.SubmissionGuide>
<Let as="instructions">
{material.instructions}

Read {guide.path} when preparing the result. Open it earlier only if a
reporting requirement affects a decision you need to make. Keep progress
updates in plain prose.
</Let>
<Let as="evidence">
Captured evidence:
<Json value={props.inputs} />
</Let>
<Let as="evidenceReference">
Read the captured evidence in {call.directory}/inputs.json. Each entry contains the original path and its captured content. Start with the paths relevant to the assignment and inspect one entry at a time. Cite the original paths in your result.
</Let>
<Let as="prompt" value={props.inputs.length === 0 ? instructions : instructions + "\n\n" + evidence} />
<If condition={prompt.length > 64000}>
<Let as="prompt" value={instructions + "\n\n" + evidenceReference} />
</If>
<If condition={prompt.length > 64000}><Fail message="The problem-solver assignment exceeds 64000 characters. Shorten the assignment in a fresh attempt." /></If>
<Let as="catalog" value={null} />
<Let as="turn" value={null} />
<Ticket.Checkout repository={assignment.repository} as="before" />
<If condition={before.head !== assignment.revision || !before.clean}><Fail message="The diagnostic checkout must be clean and at the assigned revision before prompting." /></If>
<Dir path={assignment.repository}>
<AgentProvider name="diagnostic-acpx" defaultAgent={solver.provider}>
<Delivery.Inspect agent={solver.provider} choices={call.models} as="catalog" />
<Try>
<If condition={catalog.state === "selected"}>
<Delivery.Turn as="turn">
<Agent name={solver.provider}><Session name={solver.session} model={catalog.model} effort={solver.effort}><Phase.Session directory={identities} name={solver.session} requireExisting={call.requireExisting}><Prompt timeout="30m" throwOnError={true}>{prompt}</Prompt></Phase.Session></Session></Agent>
</Delivery.Turn>
</If>
<Finally><Dir path={call.directory}><File path="outcome.json"><Json value={{catalog,turn}} /></File></Dir></Finally>
</Try>
<If condition={turn?.state === "reply"}><Dir path={call.directory}><File path="raw.txt">{turn.reply}</File></Dir></If>
</AgentProvider>
</Dir>
<Ticket.Checkout repository={assignment.repository} as="after" />
<If condition={after.head !== assignment.revision || !after.clean}><Fail message="The diagnostic checkout changed. Preserve the attempt for reconciliation." /></If>
<If condition={turn?.state === "reply"}>
<Phase.SubmissionGuide repository={assignment.repository} directory={call.directory} mode="check">{submission}</Phase.SubmissionGuide>
</If>
<Return value={{record,catalog,turn}} />
