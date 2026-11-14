---
description: 'Record a read-only diagnostic turn for an assigned revision. Use <Diagnosis.Attempt request={request} directory={directory} position={0} inputs={inputs} identities={identities} solver={solver} solverKey={key} models={models} as="attempt" />.'
props:
  type: object
  properties:
    request: {type: object}
    directory: {type: string, pattern: '^/'}
    position: {enum: [0, 1]}
    inputs: {type: array}
    identities: {type: string, pattern: '^/'}
    solver: {type: object}
    solverKey: {type: string}
    models: {type: array, minItems: 1, items: {type: string}}
    requireExisting: {type: boolean, default: false}
  required: [request, directory, position, inputs, identities, solver, solverKey, models]
  additionalProperties: false
returns: {type: object}
---

<Let as="request" value={props.request} />
<Let as="assignment" value={request.assignment} />
<Let as="solver" value={props.solver} />
<Let as="identities" value={props.identities} />
<Ticket.Fingerprint inputs={props.inputs} as="evidence" />
<Let as="record" value={{schema:"diagnosis-attempt.v1",assignment,primarySession:request.session,position:props.position,solver,solverKey:props.solverKey,identities,previous:request.previous ?? null,evidence}} />
<Dir path={props.directory}><File path="assignment.json"><Json value={record} /></File><File path="inputs.json"><Json value={props.inputs} /></File></Dir>
<Diagnosis.Schema as="schema" />
<Let as="submission">
# Submit a diagnosis result

Read this when preparing the final diagnosis, including a missing-witness result.

Return `cause` only when the captured evidence distinguishes the cause from
other plausible explanations. In `cause`, state the diagnosis and explain how
the observations support it. In `evidence[]`, put only exact `path` values from
the captured inputs. Copy each path verbatim. Give a regression command, its
expected and observed behavior, and a bounded implementation handoff.

If the evidence is inconclusive, return `missing_witness`. Use `witness` to name
the specific missing observation and `howToObtain` to explain how to capture it.

Return one JSON object. Keep any progress updates in plain prose.

<Json value={schema.result} />
</Let>
<Phase.SubmissionGuide repository={assignment.repository} directory={props.directory} as="guide">{submission}</Phase.SubmissionGuide>
<Let as="specSection" value={null} />
<If condition={assignment.spec !== undefined}>
<Dir path={assignment.repository}>
<Git.File commit={assignment.revision} path={assignment.spec.split("#")[0]} limit={2097152} as="specFile" />
<If condition={specFile.next !== null}><Fail message="The spec file exceeds the supported read size. Select a section in a smaller spec file." /></If>
<Diagnosis.SpecSection reference={assignment.spec} source={specFile.text} as="specSection" />
</Dir>
</If>
<Let as="instructions">
Diagnose the failure using the assigned checkout at {assignment.revision}. Read the repository instructions. Use the captured evidence and reuse the listed probes where they address the missing witness. Run focused commands in owned scratch space and join them before replying. Keep source, workflow records, and external systems read-only.

<If condition={specSection !== null}>
Owning spec section from {assignment.spec} at {assignment.revision}

{specSection}
</If>
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
<Delivery.Inspect agent={solver.provider} choices={props.models} as="catalog" />
<Try>
<If condition={catalog.state === "selected"}>
<Delivery.Turn as="turn">
<Agent name={solver.provider}><Session name={solver.session} model={catalog.model} effort={solver.effort}><Phase.Session directory={identities} name={solver.session} requireExisting={props.requireExisting}><Prompt timeout="30m" throwOnError={true}>{prompt}</Prompt></Phase.Session></Session></Agent>
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
