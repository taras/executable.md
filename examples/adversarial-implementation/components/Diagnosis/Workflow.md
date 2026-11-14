---
props:
  type: object
  properties:
    request: {type: object}
    solvers: {type: object}
    contract: {type: object}
  required: [request, solvers, contract]
  additionalProperties: false
returns: {type: object}
---

<If condition={props.solvers.primary.key === props.solvers.fallback?.key}><Fail message="Primary and fallback solvers must use distinct keys." /></If>
<Let as="previous" value={null} />
<Let as="previousModel" value={null} />
<Let as="inputs" value={[]} />
<If condition={props.request.previous !== undefined}>
<Ticket.Read path={props.request.previous + "/assignment.json"} limit={1048576} as="saved" />
<Parse schema={props.contract.records.prior} as="previous">{saved}</Parse>
<If condition={previous.primarySession !== props.request.session || previous.assignment.repository !== props.request.assignment.repository || previous.assignment.revision !== props.request.assignment.revision || previous.assignment.work !== props.request.assignment.work}><Fail message="Continue the original problem-solver assignment at its recorded revision and session." /></If>
<Content slot="continuation" />
<Ticket.Read path={props.request.previous + "/inputs.json"} as="savedInputs" />
<Parse schema={props.contract.records.inputs} as="inputs">{savedInputs}</Parse>
<Ticket.Fingerprint inputs={inputs} as="fingerprint" />
<If condition={JSON.stringify(fingerprint) !== JSON.stringify(previous.evidence)}><Fail message="The saved diagnostic inputs differ from their recorded fingerprints." /></If>
<Ticket.Capture as="readResult"><Ticket.Read path={props.request.previous + "/result.json"} limit={props.contract.records.receiptLimit} as="text" /><Json value={text} /></Ticket.Capture>
<If condition={readResult.status !== "completed"}><Fail message="Reconcile the original diagnostic turn before continuing it." /></If>
<Parse schema={props.contract.records.receipt} as="priorResult"><Json value={JSON.parse(JSON.parse(readResult.output))} /></Parse>
<If condition={JSON.stringify(priorResult.assignment) !== JSON.stringify(previous) || priorResult.result.revision !== props.request.assignment.revision}><Fail message="The saved result does not match the original diagnostic assignment." /></If>
<Ticket.Read path={previous.identities + "/" + encodeURIComponent(previous.solver.session) + ".json"} limit={1048576} as="sessionText" />
<Parse schema={props.contract.records.identity} as="sessionReceipt">{sessionText}</Parse>
<If condition={JSON.stringify(sessionReceipt) !== JSON.stringify(priorResult.identity)}><Fail message="The saved diagnostic session receipt differs from the original result." /></If>
<Let as="previousModel" value={priorResult.model} />
</If>
<Diagnosis.Paths repository={props.request.assignment.repository} attempt={props.request.attempt} session={props.request.session} retained={previous === null ? [] : [props.request.previous, props.request.previous + "/continuation", previous.identities, previous.identities + "/" + encodeURIComponent(previous.solver.session) + ".json", previous.identities + "/" + encodeURIComponent(previous.solver.session) + ".json.mismatch.json"]} as="resolved" />
<Let as="identities" value={previous?.identities ?? resolved.identities} />
<Ticket.Checkout repository={props.request.assignment.repository} as="source" />
<If condition={source.head !== props.request.assignment.revision || !source.clean}><Fail message="Select the clean diagnostic checkout at its exact assigned revision." /></If>
<Diagnosis.Inputs repository={props.request.assignment.repository} paths={props.request.inputPaths} retained={inputs} as="captured" />
<Parse schema={props.contract.records.inputs} as="inputs"><Json value={captured} /></Parse>
<Let as="assignment" value={{...previous?.assignment,...props.request.assignment}} />
<Content slot="evidence" />
<Ticket.ReserveDecision path={resolved.directory} as="reserved" />
<If condition={!reserved}><Fail message="The diagnostic attempt is already reserved. Preserve it and reconcile before continuing." /></If>
<If condition={previous !== null}>
<Ticket.ReserveDecision path={props.request.previous + "/continuation"} as="linked" />
<If condition={!linked}><Fail message="The original diagnostic result already has a reserved continuation. Reconcile it before prompting again." /></If>
<Dir path={props.request.previous + "/continuation"}><File path="next.json"><Json value={{attempt:resolved.directory}} /></File></Dir>
</If>
<Let as="position" value={previous?.position ?? 0} />
<Let as="key" value={previous?.solverKey ?? (position === 0 ? props.solvers.primary.key : props.solvers.fallback?.key ?? "fallback")} />
<Let as="directory" value={resolved.directory + "/" + key} />
<Let as="solver" value={previous?.solver ?? {provider:props.solvers.primary.provider,model:props.solvers.primary.models[0],effort:props.solvers.primary.effort,session:resolved.name+"-"+key}} />
<Diagnosis.Dispatch request={{...props.request,assignment}} inputs={inputs} reply={props.contract.reply} call={{identities,directory,position,solverKey:key,solver,models:previous === null ? props.solvers.primary.models : [previousModel],quotaNotice:previous === null ? props.solvers.primary.quotaNotice : undefined,requireExisting:previous !== null}} as="attempt">
<Content />
</Diagnosis.Dispatch>
<If condition={previous === null && attempt.replace && props.solvers.fallback !== undefined}>
<Let as="fallback" value={props.solvers.fallback} />
<Let as="directory" value={resolved.directory + "/" + fallback.key} />
<Let as="solver" value={{provider:fallback.provider,model:fallback.models[0],effort:fallback.effort,session:resolved.name+"-"+fallback.key}} />
<Diagnosis.Dispatch request={{...props.request,assignment}} inputs={inputs} reply={props.contract.reply} call={{identities,directory,position:1,solverKey:fallback.key,solver,models:fallback.models,requireExisting:false}} as="attempt">
<Content />
</Diagnosis.Dispatch>
</If>
<Return value={attempt.result} />
