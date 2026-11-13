---
description: 'Run a recorded problem-solver assignment. Use <Diagnosis.Run request={request} as="diagnosis" />.'
props:
  type: object
  properties:
    request: {type: object}
  required: [request]
  additionalProperties: false
returns: {type: object}
---

<Diagnosis.Schema as="schema" />
<Parse schema={schema.request} as="request"><Json value={props.request} /></Parse>
<Let as="previous" value={null} />
<Let as="previousModel" value={null} />
<Let as="priorName" value={null} />
<Let as="inputs" value={[]} />
<If condition={request.previous !== undefined}>
<Ticket.Read path={request.previous + "/assignment.json"} limit={1048576} as="saved" />
<Parse schema={schema.prior} as="previous">{saved}</Parse>
<If condition={previous.primarySession !== request.session || previous.assignment.repository !== request.assignment.repository || previous.assignment.revision !== request.assignment.revision || previous.assignment.work !== request.assignment.work}><Fail message="Continue the original diagnostic assignment at its recorded revision and session." /></If>
<Ticket.Read path={request.previous + "/inputs.json"} limit={1048576} as="savedInputs" />
<Parse schema={schema.inputs} as="inputs">{savedInputs}</Parse>
<Ticket.Fingerprint inputs={inputs} as="fingerprint" />
<If condition={JSON.stringify(fingerprint) !== JSON.stringify(previous.evidence)}><Fail message="The saved diagnostic inputs differ from their recorded fingerprints." /></If>
<Ticket.Capture as="readResult"><Ticket.Read path={request.previous + "/result.json"} limit={1048576} as="text" /><Json value={text} /></Ticket.Capture>
<If condition={readResult.status !== "completed"}><Fail message="Reconcile the original diagnostic turn before continuing it." /></If>
<Parse schema={schema.receipt} as="priorResult"><Json value={JSON.parse(JSON.parse(readResult.output))} /></Parse>
<If condition={JSON.stringify(priorResult.assignment) !== JSON.stringify(previous) || priorResult.result.revision !== request.assignment.revision}><Fail message="The saved result does not match the original diagnostic assignment." /></If>
<Ticket.Read path={previous.identities + "/" + encodeURIComponent(previous.solver.session) + ".json"} limit={1048576} as="sessionText" />
<Parse schema={schema.identity} as="sessionReceipt">{sessionText}</Parse>
<If condition={JSON.stringify(sessionReceipt) !== JSON.stringify(priorResult.identity)}><Fail message="The saved diagnostic session receipt differs from the original result." /></If>
<Let as="previousModel" value={priorResult.model} />
<Let as="suffix" value={previous.position === 0 ? "-fable" : "-astra"} />
<Let as="priorName" value={previous.solver.session.slice(0,-suffix.length)} />
</If>
<Diagnosis.Paths repository={request.assignment.repository} attempt={request.attempt} session={request.session} retained={previous === null ? [] : [request.previous, request.previous + "/continuation", previous.identities, previous.identities + "/" + encodeURIComponent(previous.solver.session) + ".json", previous.identities + "/" + encodeURIComponent(previous.solver.session) + ".json.mismatch.json"]} as="resolved" />
<Let as="namespace" value={previous === null ? resolved : {directory:resolved.directory,identities:previous.identities,name:priorName}} />
<Ticket.Checkout repository={request.assignment.repository} as="source" />
<If condition={source.head !== request.assignment.revision || !source.clean}><Fail message="Select the clean diagnostic checkout at its exact assigned revision." /></If>
<Diagnosis.Inputs repository={request.assignment.repository} paths={request.inputPaths} retained={inputs} as="captured" />
<Parse schema={schema.inputs} as="inputs"><Json value={captured} /></Parse>
<Ticket.ReserveDecision path={namespace.directory} as="reserved" />
<If condition={!reserved}><Fail message="The diagnostic attempt is already reserved. Preserve it and reconcile before continuing." /></If>
<If condition={previous !== null}>
<Ticket.ReserveDecision path={request.previous + "/continuation"} as="linked" />
<If condition={!linked}><Fail message="The original diagnostic result already has a reserved continuation. Reconcile it before prompting again." /></If>
<Dir path={request.previous + "/continuation"}><File path="next.json"><Json value={{attempt:namespace.directory}} /></File></Dir>
</If>
<Let as="position" value={previous?.position ?? 0} />
<Let as="directory" value={namespace.directory + (position === 1 ? "/astra" : "/fable")} />
<Diagnosis.Dispatch request={request} namespace={namespace} directory={directory} position={position} inputs={inputs} previous={previous} previousModel={previousModel} as="attempt" />
<If condition={previous === null && attempt.replace}>
<Let as="directory" value={namespace.directory + "/astra"} />
<Diagnosis.Dispatch request={request} namespace={namespace} directory={directory} position={1} inputs={inputs} as="attempt" />
</If>
<Return value={attempt.result} />
