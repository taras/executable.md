---
description: 'Run a recorded problem-solver assignment. Use <Diagnosis.Run request={request} solvers={solvers} as="diagnosis" />.'
props:
  type: object
  properties:
    request: {type: object}
    solvers: {type: object}
  required: [request, solvers]
  additionalProperties: false
returns: {type: object}
---

<Diagnosis.Schema as="schema" />
<Parse schema={schema.request} as="request"><Json value={props.request} /></Parse>
<Parse schema={schema.solvers} as="solvers"><Json value={props.solvers} /></Parse>
<If condition={solvers.primary.key === solvers.fallback?.key}><Fail message="Primary and fallback solvers must use distinct keys." /></If>
<Let as="previous" value={null} />
<Let as="previousModel" value={null} />
<Let as="inputs" value={[]} />
<If condition={request.previous !== undefined}>
<Ticket.Read path={request.previous + "/assignment.json"} limit={1048576} as="saved" />
<Parse schema={schema.prior} as="previous">{saved}</Parse>
<If condition={previous.primarySession !== request.session || previous.assignment.repository !== request.assignment.repository || previous.assignment.revision !== request.assignment.revision || previous.assignment.work !== request.assignment.work}><Fail message="Continue the original diagnostic assignment at its recorded revision and session." /></If>
<If condition={previous.assignment.failingRevision !== undefined && request.assignment.failingRevision !== undefined && previous.assignment.failingRevision !== request.assignment.failingRevision}><Fail message="The failing revision differs from the original diagnostic assignment. Use a fresh assignment for a different failing revision." /></If>
<Let as="request" value={{...request,assignment:{...previous.assignment,...request.assignment}}} />
<Ticket.Read path={request.previous + "/inputs.json"} as="savedInputs" />
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
</If>
<Diagnosis.Paths repository={request.assignment.repository} attempt={request.attempt} session={request.session} retained={previous === null ? [] : [request.previous, request.previous + "/continuation", previous.identities, previous.identities + "/" + encodeURIComponent(previous.solver.session) + ".json", previous.identities + "/" + encodeURIComponent(previous.solver.session) + ".json.mismatch.json"]} as="resolved" />
<Let as="identities" value={previous?.identities ?? resolved.identities} />
<Ticket.Checkout repository={request.assignment.repository} as="source" />
<If condition={source.head !== request.assignment.revision || !source.clean}><Fail message="Select the clean diagnostic checkout at its exact assigned revision." /></If>
<Diagnosis.Inputs repository={request.assignment.repository} paths={request.inputPaths} retained={inputs} as="captured" />
<Parse schema={schema.inputs} as="inputs"><Json value={captured} /></Parse>
<Ticket.ReserveDecision path={resolved.directory} as="reserved" />
<If condition={!reserved}><Fail message="The diagnostic attempt is already reserved. Preserve it and reconcile before continuing." /></If>
<If condition={previous !== null}>
<Ticket.ReserveDecision path={request.previous + "/continuation"} as="linked" />
<If condition={!linked}><Fail message="The original diagnostic result already has a reserved continuation. Reconcile it before prompting again." /></If>
<Dir path={request.previous + "/continuation"}><File path="next.json"><Json value={{attempt:resolved.directory}} /></File></Dir>
</If>
<Let as="position" value={previous?.position ?? 0} />
<Let as="key" value={previous?.solverKey ?? (position === 0 ? solvers.primary.key : solvers.fallback?.key ?? "fallback")} />
<Let as="directory" value={resolved.directory + "/" + key} />
<Let as="solver" value={previous?.solver ?? {provider:solvers.primary.provider,model:solvers.primary.models[0],effort:solvers.primary.effort,session:resolved.name+"-"+key}} />
<Diagnosis.Dispatch request={request} identities={identities} directory={directory} position={position} solverKey={key} solver={solver} models={previous === null ? solvers.primary.models : [previousModel]} quotaNotice={previous === null ? solvers.primary.quotaNotice : undefined} inputs={inputs} requireExisting={previous !== null} as="attempt" />
<If condition={previous === null && attempt.replace && solvers.fallback !== undefined}>
<Let as="fallback" value={solvers.fallback} />
<Let as="directory" value={resolved.directory + "/" + fallback.key} />
<Let as="solver" value={{provider:fallback.provider,model:fallback.models[0],effort:fallback.effort,session:resolved.name+"-"+fallback.key}} />
<Diagnosis.Dispatch request={request} identities={identities} directory={directory} position={1} solverKey={fallback.key} solver={solver} models={fallback.models} inputs={inputs} as="attempt" />
</If>
<Return value={attempt.result} />
