---
description: Validate the reserved original reply for Ticket.ReconcileResponse.
props:
  type: object
  properties:
    record: {type: object}
    proof: {type: string, pattern: '^/'}
  required: [record, proof]
  additionalProperties: false
returns: {type: object}
---

A recovered reply enters its original feedback gate. The failed call, original
receipts, conversations and correction allowances remain the evidence of what
happened. This action publishes a separate validated derivative and calls no role.

<Ticket.Envelope value={props.record} as="envelope" />
<Ticket.Load record={envelope} as="saved" />
<Let as="state" value={saved.checkpoint} />
<Let as="repository" value={saved.manifest.assignment.repository} />
<Let as="call" value={saved.calls.at(-1)} />
<Let as="held" value={{schema:"ticket-return.v1",work:envelope.work,source:envelope.source,status:"hold",revision:envelope.revision,publication:"held",continuation:envelope.continuation,pending:null,hold:"Reconciliation did not establish a confirmed successor; preserve the original return and reconciliation receipts."}} />
<Let as="dispositions" value={state.feedback.filter(path => /\/reconciliations\/[0-9a-f]{64}\/disposition\.json$/.test(path))} />
<Loop max={1}>
<If condition={dispositions.length !== 0}>
<If condition={dispositions.length !== 1}><Fail message="The confirmed successor has contradictory reconciliation links." /></If>
<Ticket.Hydrate repository={repository} document={saved.documents[dispositions[0]]} as="dispositionText" />
<Parse schema={{type:"object"}} as="disposition">{dispositionText.content}</Parse>
<If condition={disposition.schema !== "joined-response-disposition.v1" || disposition.status !== "accepted" || disposition.proof.path !== props.proof || disposition.call !== call.id || disposition.gate !== state.gate || state.status !== "paused" || !state.dispatchable || state.hold !== null || !state.feedback.includes(disposition.derivative.path)}>
<Fail message="The confirmed record or proof reference does not match its reconciliation derivative." />
</If>
<Ticket.Selected repository={repository} documents={Object.fromEntries(disposition.snapshots.map(path => [path,saved.documents[path]]))} as="retained" />
<If condition={saved.documents[props.proof].sha256 !== disposition.proof.sha256 || saved.documents[props.proof].utf8Bytes !== disposition.proof.utf8Bytes || saved.documents[disposition.derivative.path].sha256 !== disposition.derivative.sha256 || saved.documents[disposition.derivative.path].utf8Bytes !== disposition.derivative.utf8Bytes}>
<Fail message="The retained proof or derivative linkage changed." />
</If>
<Ticket.Outward value={envelope} as="bounded" /><Return value={bounded} /><Break />
</If>
<If condition={envelope.status !== "hold" || state.status !== "hold" || state.dispatchable || state.hold?.kind !== "execution_failure" || call?.status !== "failed_without_result" || call.role !== "implementor" || call.assignment.phase !== "implementation" || call.result !== undefined && call.result !== null}>
<Fail message="Reconciliation covers only a confirmed original implementation extraction hold without a canonical result." />
</If>
<Let as="reservation" value={saved.manifest.directory + "/reconciliations/" + envelope.continuation.sha256} />
<Let as="quoted" value={"'" + reservation.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="existing"
if test -e {quoted} || test -L {quoted}; then printf reserved; else printf none; fi
```
<If condition={existing.exitCode !== 0}><Fail message="Cannot inspect the reconciliation reservation." /></If>
<If condition={existing.stdout !== "none"}>
<Return value={{...held,hold:"This original hold already has a reconciliation reservation at " + reservation + ". Preserve its first failure and retained disposition. Only the actual confirmed returned successor permits a confirmed repeat; matching files do not acknowledge publication."}} /><Break />
</If>
<Ticket.Read path={call.preparation} limit={1048576} as="preparationText" />
<Parse schema={{type:"object"}} as="preparation">{preparationText}</Parse>
<Ticket.WorkflowSource as="workflowRoot" />
<Ticket.RecoveryOwner root={workflowRoot} as="owner" />
<Let as="workflowQuoted" value={"'" + workflowRoot.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="workflow"
set -e
git -C {workflowQuoted} rev-parse HEAD
git -C {workflowQuoted} status --porcelain --untracked-files=no -- examples/adversarial-implementation
```
<If condition={workflow.exitCode !== 0 || preparation.workflow?.dirty !== false || workflow.stdout.split("\n")[0] !== preparation.workflow.revision || workflow.stdout.split("\n").slice(1).join("\n").trim() !== ""}>
<Fail message="The effective workflow owner is not clean at the original prepared pin." />
</If>
<Ticket.JoinedProof path={props.proof} mode="admit" record={envelope} call={call} request="" raw="" as="admitted" />
<Ticket.ReserveDecision path={reservation} as="reserved" />
<If condition={!reserved}><Return value={{...held,hold:"Another reconciliation owns " + reservation + "; no second writer or role was started."}} /><Break /></If>
<Let as="requestReceipt" value={{schema:"joined-response-request.v1",record:envelope,call:call.id,proof:admitted.file,references:admitted.references,owner}} />
<Ticket.SaveMetadata name="requestReceipt" repository={repository} path={reservation + "/request.json"} as="requestDescriptor" />
<Ticket.Capture as="validation">
<Ticket.Checkout repository={repository} as="before" />
<Ticket.Read path={call.record + "/call.json"} limit={1048576} as="originalCallText" />
<Parse schema={{type:"object"}} as="originalCall">{originalCallText}</Parse>
<Ticket.RecoveryCorrespondence original={originalCall} recorded={Object.fromEntries(Object.entries(call).filter(([key]) => !["status","execution","delivery","profile"].includes(key)))} as="callCorresponds" />
<If condition={!callCorresponds}><Fail message="The original final call receipt changed." /></If>
<Ticket.Read path={call.attempt + "/assignment.json"} limit={1048576} as="assignmentText" />
<Phase.Schema as="schemas" />
<Parse schema={schemas.assignment} as="assignment">{assignmentText}</Parse>
<Parse schema={schemas.assignment} as="expectedAssignment"><Json value={call.assignment} /></Parse>
<Ticket.RecoveryCorrespondence original={assignment} recorded={expectedAssignment} as="assignmentCorresponds" />
<If condition={!assignmentCorresponds}><Fail message="The final call assignment differs from its retained attempt." /></If>
<Ticket.Read path={call.execution} limit={1048576} as="executionText" />
<Parse schema={{type:"object",properties:{status:{const:"failed"},output:{type:"string"},failure:{type:"string"}},required:["status","output","failure"],additionalProperties:false}} as="execution">{executionText}</Parse>
<Ticket.Read path={call.attempt + "/response-disposition.json"} limit={1048576} as="responseText" />
<Parse schema={{type:"object"}} as="response">{responseText}</Parse>
<If condition={response.status !== "failed_without_result" || response.dispatchable !== false || response.code !== "response_correction_unestablished" || response.consumed !== 0 || response.substantiveEstablished !== false || response.lastRejection?.code !== "extraction" || !execution.failure.includes("response_correction_unestablished")}>
<Fail message="The original failure is not solely an unestablished extraction rejection." />
</If>
<Let as="nextId" value={String(saved.calls.length).padStart(4,"0")} />
<Let as="slots" value={[call.attempt + "/result.json",...["calls","attempts","preparations"].map(part => saved.manifest.directory + "/" + part + "/" + nextId)].map(path => "'" + path.replaceAll("'","'\"'\"'") + "'").join(" ")} />
```bash exec as="unoccupied"
for path in {slots}; do if test -e "$path" || test -L "$path"; then exit 1; fi; done
```
<If condition={unoccupied.exitCode !== 0}><Fail message="A canonical result or later reserved work already exists; preserve the original ownership." /></If>
<Ticket.Read path={call.delivery} limit={1048576} as="deliveryText" />
<Parse schema={{type:"object"}} as="delivery">{deliveryText}</Parse>
<Ticket.Selected repository={repository} documents={Object.fromEntries(call.inputs.map(input => [input.path,input]))} as="selected" />
<Let as="inputs" value={call.inputs.map(input => selected[input.path])} />
<Ticket.Fingerprint inputs={inputs} as="fingerprint" />
<If condition={delivery.role !== call.role || delivery.session !== call.session || delivery.provider !== call.provider || JSON.stringify(delivery.profile) !== JSON.stringify(call.profile) || JSON.stringify(delivery.inputs) !== JSON.stringify(fingerprint) || preparation.work !== saved.manifest.work || preparation.call !== call.id || preparation.status !== "ready" || preparation.recipient.role !== call.role || preparation.recipient.session !== call.session || preparation.recipient.provider !== call.provider || preparation.sourceRevision !== call.assignment.revision}>
<Fail message="The original preparation or delivery no longer matches its selected recipient and inputs." />
</If>
<Phase.SubmissionGuide repository={repository} directory={call.attempt} mode="check" as="guide"><Phase.SubmissionInstructions role={call.role} assignment={assignment} /></Phase.SubmissionGuide>
<Phase.SubmissionInstructions role={call.role} assignment={assignment} as="instructions" />
<Let as="guideSchema" value={JSON.parse(instructions.trim().split("\n").at(-1))} />
<Dir path={repository}><Phase.Request role={call.role} assignment={assignment} inputs={inputs} initialize={call.initialize} as="composed" /></Dir>
<Ticket.Read path={call.attempt + "/raw.txt"} as="raw" />
<Ticket.JoinedProof path={props.proof} mode="validate" record={envelope} call={call} request={composed} raw={raw} as="joined" />
<If condition={JSON.stringify(joined.file) !== JSON.stringify(admitted.file)}><Fail message="The admitted proof changed during validation." /></If>
<If condition={owner.definitions.some(actual => !joined.imports.some(original => original.name === actual.name && original.sha256 === actual.sha256 && original.utf8Bytes === actual.utf8Bytes))}>
<Fail message="The effective owning definitions differ from the original retained imports." />
</If>
<Phase.Extract text={raw} as="extracted" />
<If condition={!extracted.ok}><Fail message={extracted.rejection.message} /></If>
<Parse schema={{type:"object"}} as="candidate">{extracted.json}</Parse>
<Phase.Metadata assignment={assignment} value={candidate} as="metadata" />
<Phase.Revisions repository={repository} value={metadata} as="revisions" />
<If condition={!revisions.ok}><Fail message={revisions.rejection.message} /></If>
<If condition={guideSchema.required.some(key => !Object.hasOwn(revisions.value,key))}><Fail message="The original object omits a field required by its frozen role guide." /></If>
<Parse schema={guideSchema} as="frozen"><Json value={revisions.value} /></Parse>
<If condition={candidate.outcome !== "complete" || candidate.assessment === undefined}><Fail message="Only a completed implementation with its genuine impact assessment can enter original feedback." /></If>
<ReviewPolicy assessment={candidate.assessment} kind={assignment.reviewKind ?? "feature"} as="policy" />
<Let as="actualNext" value={policy.reviewers.length === 0 ? null : {phase:"review",role:policy.reviewers[0]}} />
<If condition={actualNext === null}><Fail message="The original policy has no eligible feedback gate." /></If>
<If condition={candidate.next !== undefined}>
<Ticket.RecoveryCorrespondence original={candidate.next} recorded={assignment.continuation} as="predictedRoute" />
<Ticket.RecoveryCorrespondence original={candidate.next} recorded={actualNext} as="policyRoute" />
<If condition={!predictedRoute && !policyRoute}><Fail message="The original explicit route contradicts its predicted or actual-policy feedback gate." /></If>
</If>
<Phase.Response assignment={assignment} text={raw} role={call.role} profile={{kind:"ticket",knownDocuments:Object.keys(saved.documents)}} as="checked" />
<If condition={!checked.ok}><Fail message={checked.rejection.message} /></If>
<Let as="result" value={checked.value} />
<Ticket.Capacity name="result" as="resultFits" />
<If condition={!resultFits}><Fail message="The recovered result exceeds metadata capacity." /></If>
<If condition={before.head !== result.revision || !before.clean}><Fail message="The resulting implementation source is not the actual clean HEAD." /></If>
<Dir path={repository}>
```bash exec as="ancestry"
git merge-base --is-ancestor {saved.manifest.assignment.revision} {result.revision}
```
</Dir>
<If condition={ancestry.exitCode !== 0}><Fail message="The resulting source does not descend from the accepted launch." /></If>
<Ticket.ChangedPaths repository={repository} base={saved.manifest.assignment.revision} head={result.revision} as="changes" />
<If condition={saved.manifest.api && changes.paths.some(path => saved.manifest.api.ownedPaths.includes(path))}><Fail message="The implementation changed a migration-owned API path." /></If>
<Ticket.Signature repository={repository} revision={result.revision} as="signature" />
<If condition={signature.exitCode !== 0}><Fail message="The resulting implementation commit has no valid signature." /></If>
<Ticket.Checkout repository={repository} as="after" />
<If condition={JSON.stringify(after) !== JSON.stringify(before)}><Fail message="Source changed during reconciliation validation." /></If>
<Json value={{result,span:extracted.span,raw:call.attempt + "/raw.txt",normalizations:[...Object.keys(checked.value).filter(key => !Object.hasOwn(candidate,key)).map(key => ({field:key,kind:["phase","work","next"].includes(key) ? "assignment_metadata" : "canonical_default",value:checked.value[key]})),...checked.normalizations.map(change => ({kind:"revision_expansion",...change})),...(candidate.next !== undefined && JSON.stringify(candidate.next) !== JSON.stringify(checked.value.next) ? [{field:"next",kind:"actual_policy",original:candidate.next,value:checked.value.next}] : [])],joined,guide,execution,source:{revision:result.revision,checkout:after,ancestry,changes,changedPaths:changes.paths,signature,artifacts:result.artifacts,evidence:result.evidence}}} />
</Ticket.Capture>
<If condition={validation.status !== "completed"}>
<Let as="refusal" value={{schema:"joined-response-disposition.v1",status:"refused",call:call.id,request:requestDescriptor,proof:admitted.file,reason:validation.failure}} />
<Ticket.SaveMetadata name="refusal" repository={repository} path={reservation + "/disposition.json"} as="refusalDescriptor" />
<Return value={{...held,hold:"Reconciliation refused: " + validation.failure.split("\n")[0] + ". Preserve " + refusalDescriptor.path}} /><Break />
</If>
<Parse schema={{type:"object"}} as="validated">{validation.output}</Parse>
<Let as="result" value={validated.result} />
<Ticket.SaveMetadata name="result" repository={repository} path={reservation + "/result.json"} as="derivative" />
<Let as="observation" value={{...validated.source,path:reservation + "/source.json",exactApproval:null,exactReceipt:null}} />
<Ticket.SaveMetadata name="observation" repository={repository} path={observation.path} as="sourceDescriptor" />
<Ticket.Advance pending={{...saved,call,execution:validated.execution,resultPath:derivative.path}} result={result} observation={observation} as="advanced" />
<If condition={advanced.status !== "paused" || !["architect-review","planner-review"].includes(advanced.gate) || advanced.hold !== null}><Fail message="The owning Advance did not select an original paused feedback gate." /></If>
<Let as="snapshots" value={[props.proof,call.attempt + "/raw.txt",call.record + "/call.json",call.execution,call.attempt + "/assignment.json",call.attempt + "/submission-guide.md",call.attempt + "/submission-guide.json",call.attempt + "/response-disposition.json",call.attempt + "/response-rejection-0000.json",call.delivery,call.preparation,...admitted.references.map(entry => entry.path),...validated.joined.originals.map(entry => entry.path),requestDescriptor.path,derivative.path,sourceDescriptor.path,...result.artifacts,...(result.assessment?.evidence ?? []),...result.evidence.flatMap(entry => entry.revision === null ? [entry.artifact,entry.candidate] : [entry.artifact])]} />
<Let as="disposition" value={{schema:"joined-response-disposition.v1",status:"accepted",call:call.id,request:requestDescriptor,original:envelope.continuation,proof:admitted.file,raw:validated.joined.raw,span:validated.span,normalizations:validated.normalizations,derivative,source:sourceDescriptor,guide:validated.guide,gate:advanced.gate,snapshots,originalExecution:call.execution,originalCall:call.record + "/call.json"}} />
<Ticket.SaveMetadata name="disposition" repository={repository} path={reservation + "/disposition.json"} as="dispositionDescriptor" />
<Ticket.Capture as="publicationCheck">
<Ticket.Documents repository={repository} directory={saved.manifest.directory} paths={[...snapshots,dispositionDescriptor.path]} documents={saved.documents} as="documents" />
<If condition={[admitted.file,...admitted.references,...validated.joined.originals,requestDescriptor,derivative,sourceDescriptor,dispositionDescriptor].some(expected => documents[expected.path].sha256 !== expected.sha256 || documents[expected.path].utf8Bytes !== expected.utf8Bytes)}><Fail message="A recovery input changed before snapshot publication; preserve the reservation." /></If>
<Let as="checkpoint" value={{...advanced,status:"paused",dispatchable:true,hold:null,feedback:[...advanced.feedback,dispositionDescriptor.path,requestDescriptor.path],feedbackInputs:[...new Set([...advanced.feedbackInputs,...admitted.proof.handoffInputs.map(entry => entry.path)])]}} />
<Let as="successor" value={{...saved,documents,checkpoint}} />
<Ticket.Gate record={successor} as="next" />
<Ticket.Inputs record={successor} call={next.call} inspect={true} as="selection" />
<If condition={!selection.budget.admitted || next.call.assignment.handoffInputs.length > 12}><Fail message="The recovered selected feedback exceeds the original input capacity." /></If>
<Ticket.Capacity name="successor" as="fits" />
<If condition={!fits}><Fail message="The recovered continuation exceeds metadata capacity." /></If>
<Ticket.Checkout repository={repository} as="finalSource" />
<If condition={JSON.stringify(finalSource) !== JSON.stringify(validated.source.checkout)}><Fail message="Source changed before reconciliation publication." /></If>
<Json value={successor} />
</Ticket.Capture>
<If condition={publicationCheck.status !== "completed"}>
<Let as="refusal" value={{schema:"joined-response-disposition.v1",status:"refused",call:call.id,request:requestDescriptor,proof:admitted.file,derivative,validatedDisposition:dispositionDescriptor,reason:publicationCheck.failure}} />
<Ticket.SaveMetadata name="refusal" repository={repository} path={reservation + "/publication-refusal.json"} as="refused" />
<Return value={{...held,pending:{result:derivative.path,execution:call.execution,call:call.record + "/call.json"},hold:"Publication validation refused; preserve " + refused.path + ": " + publicationCheck.failure.split("\n")[0]}} /><Break />
</If>
<Parse schema={{type:"object"}} as="successor">{publicationCheck.output}</Parse>
<Ticket.Publish record={successor} previous={envelope} pending={{result:derivative.path,execution:call.execution,call:call.record + "/call.json"}} as="published" />
<If condition={published.publication !== "confirmed"}><Return value={published} /><Break /></If>
<Let as="confirmation" value={{schema:"joined-response-confirmation.v1",request:requestDescriptor,original:envelope.continuation,call:call.id,proof:admitted.file,derivative,source:sourceDescriptor,disposition:dispositionDescriptor,successor:published}} />
<Ticket.SaveMetadata name="confirmation" repository={repository} path={reservation + "/confirmation.json"} as="confirmationDescriptor" />
<Ticket.Outward value={published} as="bounded" /><Return value={bounded} />
</Loop>
