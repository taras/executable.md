---
description: >-
  Validate a returned result and return the Markdown-selected next state.
  Use <Ticket.Settle pending={pending} as="record" />.
props:
  type: object
  properties:
    pending: {type: object}
  required: [pending]
  additionalProperties: false
returns: {type: object}
---

Provider failures without a canonical result hold without creating a verdict.
Replies are checked through the same phase contract on live execution and replay.
Every discovery disposition retains a source observation before any successor.
Discovery requires clean unchanged launch source; implementation feedback retains
its signed commit and focused evidence requirements. An admitted delivery
amendment additionally rechecks its selected workflow sources, the import's
parentage, its cumulative weights-only delta, the selected target configuration
and corpus, and the exact measured bytes.

<Let as="pending" value={props.pending} />
<Loop max={1}>
<Let as="discovery" value={pending.call.assignment.phase === "discovery"} />
<Let as="source" value={null} />
<If condition={discovery}>
<Ticket.Capture as="sourceCheck">
<Ticket.Checkout repository={pending.call.assignment.repository} as="checkout" />
<Json value={checkout} />
</Ticket.Capture>
<Dir path={pending.call.record}><File path="source.json"><Json value={sourceCheck} /></File></Dir>
<If condition={sourceCheck.status === "completed"}><Parse schema={{type:"object"}} as="source">{sourceCheck.output}</Parse></If>
<Let as="pending" value={{...pending,call:{...pending.call,source:pending.call.record + "/source.json"}}} />
<If condition={source === null || source.head !== pending.manifest.assignment.revision || !source.clean}>
<Return value={{schema:"ticket-state.v1",manifest:pending.manifest,documents:pending.documents,deliveredInputs:pending.deliveredInputs ?? {},checkpoint:{...pending.checkpoint,status:"hold",dispatchable:false,hold:{kind:"source_mismatch",reason:"Planning and discovery must leave clean unchanged launch source. Reconcile source and the original phase execution; inspect " + pending.call.record + "/source.json"}},calls:[...pending.calls,{...pending.call,status:"source_mismatch",result:pending.result === null ? null : pending.resultPath,execution:pending.call.record + "/execution.json"}]}} />
<Break />
</If>
</If>
<If condition={pending.result === null}>
<Return value={{schema:"ticket-state.v1",manifest:pending.manifest,deliveredInputs:pending.deliveredInputs ?? {},documents:pending.documents,checkpoint:{...pending.checkpoint,status:"hold",dispatchable:false,hold:{kind:"execution_failure",reason:pending.execution.failure || "No canonical role result; inspect " + pending.call.record + "/execution.json"}},calls:[...pending.calls,{...pending.call,status:"failed_without_result",execution:pending.call.record + "/execution.json"}]}} />
</If>

<If condition={pending.result !== null}>
<Ticket.Capture as="validation">
  <Json value={pending.result} as="reply" />
  <Phase.Accept assignment={pending.call.assignment} role={pending.call.role} text={reply} profile={{kind:"ticket",knownDocuments:Object.keys(pending.documents)}} as="result" />
  <If condition={(result.handoffInputs ?? []).some(path => !result.artifacts.includes(path) && !Object.hasOwn(pending.documents,path))}>
  <Fail message="Select handoffInputs from the returned artifacts or already recorded documents." />
  </If>
  <Let as="exactApproval" value={null} />
<Let as="exactReceipt" value={null} />
<If condition={result.exactCorrection !== undefined}>
<ExactCorrection.Prepare assignment={pending.call.assignment} result={result} role={pending.call.role} resultPath={pending.resultPath} as="exactApproval" />
</If>
<Let as="completed" value={result.outcome === "complete" || result.outcome === "pass" || result.outcome === "escalate"} />
  <If condition={completed && pending.call.role === "implementor" && !result.evidence.some(entry => entry.outcome === "passed")}>
  <Fail message="Implementation needs a saved focused evidence receipt." />
  </If>
  <Let as="checkout" value={null} />
  <If condition={completed && !discovery}>
    <Ticket.Checkout repository={pending.call.assignment.repository} as="checkout" />
    <Dir path={pending.call.record}><File path="checkout.json"><Json value={checkout} /></File></Dir>
    <If condition={checkout.head !== result.revision || !checkout.clean}>
    <Fail message="Feedback must identify actual clean HEAD descended from the accepted source revision." />
    </If>
  </If>
  <Let as="revision" value={completed ? result.revision : pending.checkpoint.revision} />
  <Let as="ancestry" value={null} />
  <Let as="changes" value={{paths:[]}} />
  <Let as="signature" value={null} />
  <If condition={!discovery}>
  <Dir path={pending.call.assignment.repository}>
```bash exec as="ancestry"
git merge-base --is-ancestor {pending.manifest.assignment.revision} {revision}
```
  </Dir>
  <Dir path={pending.call.record}><File path="ancestry.json"><Json value={ancestry} /></File></Dir>
  <If condition={completed && ancestry.exitCode !== 0}>
  <Fail message={"Feedback must descend from the accepted source revision; inspect " + pending.call.record + "/ancestry.json"} />
  </If>
  <Ticket.ChangedPaths repository={pending.call.assignment.repository} base={pending.manifest.assignment.revision} head={revision} as="changes" />
  <If condition={completed && pending.call.role === "implementor" && pending.manifest.api && changes.paths.some(path => pending.manifest.api.ownedPaths.includes(path))}>
  <Fail message="The migration changed an API-owned path. Preserve the commit and return an API conflict to the original Planner instead of accepting an unvalidated API change." />
  </If>
  <Dir path={pending.call.record}><File path="changes.json"><Json value={changes} /></File></Dir>
  <If condition={completed}>
    <Ticket.Signature repository={pending.call.assignment.repository} revision={revision} as="signature" />
    <Dir path={pending.call.record}><File path="signature.json"><Json value={signature} /></File></Dir>
    <If condition={signature.exitCode !== 0}>
    <Fail message={"Feedback signature verification failed; inspect " + pending.call.record + "/signature.json"} />
    </If>
  </If>
  <If condition={pending.checkpoint.amendment !== undefined}>
  <Ticket.AmendmentSources amendment={pending.checkpoint.amendment} as="amendmentSources" />
  <If condition={completed && pending.call.role === "implementor"}>
  <Dir path={pending.call.assignment.repository}>
```bash exec as="amendedParents"
git rev-list --parents -n 1 {revision}
```
```bash exec as="amendedAncestry"
git merge-base --is-ancestor {pending.checkpoint.revision} {revision}
```
```bash exec as="targetTree"
git ls-tree {revision} -- scripts/runtime-test-exclusions.ts
```
```bash exec as="targetBlob"
git hash-object -- scripts/runtime-test-exclusions.ts
```
  </Dir>
  <Ticket.ChangedPaths repository={pending.call.assignment.repository} base={pending.checkpoint.amendment.base} head={revision} as="amendedChanges" />
  <Ticket.AmendmentSettle amendment={pending.checkpoint.amendment} repository={pending.call.assignment.repository} revision={revision} previous={pending.checkpoint.revision} parents={amendedParents.stdout} descends={amendedAncestry.exitCode === 0} paths={amendedChanges.paths} targetTree={targetTree.exitCode === 0 ? targetTree.stdout : ""} targetBlob={targetBlob.exitCode === 0 ? targetBlob.stdout : null} as="amendmentReceipt" />
  <Dir path={pending.call.record}><File path="amendment.json"><Json value={amendmentReceipt} /></File></Dir>
  </If>
  </If>
  <If condition={completed && pending.call.role === "implementor" && pending.checkpoint.exactApproval}>
<ExactCorrection.Verify repository={pending.call.assignment.repository} approval={pending.checkpoint.exactApproval} revision={result.revision} as="exactReceipt" />
<Dir path={pending.call.record}><File path="exact-correction.json"><Json value={exactReceipt} /></File></Dir>
<If condition={exactReceipt.status === "failed"}><Fail message={"Exact correction checks failed; inspect " + pending.call.record + "/exact-correction.json"} /></If>
</If>
</If>
<Ticket.Documents repository={pending.call.assignment.repository} directory={pending.manifest.directory} paths={[...result.artifacts,...(result.assessment?.evidence ?? []),...result.evidence.flatMap(entry => entry.revision === null ? [entry.artifact,entry.candidate] : [entry.artifact])]} documents={pending.documents} as="documents" />
  <Ticket.SaveDocuments repository={pending.call.assignment.repository} path={pending.call.artifactDocumentRecord} documents={documents} as="artifactDocumentReceipt" />
<Let as="observation" value={{path:pending.call.record + "/observation.json",revision,exactApproval,exactReceipt,checkout:discovery ? source : checkout,ancestry,changes,changedPaths:changes.paths,signature,artifacts:result.artifacts,evidence:result.evidence}} />
  <Json value={observation} as="observationText" />
  <Dir path={pending.call.record}><File path="observation.json">{observationText}</File></Dir>
  <Ticket.Documents repository={pending.call.assignment.repository} directory={pending.manifest.directory} paths={[pending.resultPath,observation.path]} documents={documents} as="documents" />
  <Ticket.SaveDocuments repository={pending.call.assignment.repository} path={pending.call.documentRecord} documents={documents} as="documentReceipt" />
<Ticket.Advance pending={pending} result={result} observation={observation} as="checkpoint" />
  <Let as="candidate" value={{schema:"ticket-state.v1",manifest:pending.manifest,deliveredInputs:pending.deliveredInputs ?? {},checkpoint,calls:[...pending.calls,{...pending.call,status:"accepted",result:pending.resultPath,execution:pending.call.record + "/execution.json",observation:observation.path}],documents}} />
<Ticket.Capacity name="candidate" as="fits" />
<If condition={!fits}><Fail message={"Continuation metadata capacity exceeded. Preserve captured-text metadata at " + documentReceipt.path} /></If>
<Json value={{checkpoint,observation,documents}} />
</Ticket.Capture>
<If condition={validation.status === "completed"}>
<Parse schema={{type:"object"}} as="validated">{validation.output}</Parse>
<Return value={{schema:"ticket-state.v1",manifest:pending.manifest,deliveredInputs:pending.deliveredInputs ?? {},checkpoint:validated.checkpoint,calls:[...pending.calls,{...pending.call,status:"accepted",result:pending.resultPath,execution:pending.call.record + "/execution.json",observation:validated.observation.path}],documents:validated.documents}} />
</If>
<If condition={validation.status === "failed"}>
<Dir path={pending.call.record}><File path="validation.json"><Json value={validation} /></File></Dir>
<Return value={{schema:"ticket-state.v1",manifest:pending.manifest,deliveredInputs:pending.deliveredInputs ?? {},checkpoint:{...pending.checkpoint,status:"hold",dispatchable:false,hold:{kind:"verification_failure",reason:validation.failure}},calls:[...pending.calls,{...pending.call,status:"rejected",result:pending.resultPath,execution:pending.call.record + "/execution.json",validation:pending.call.record + "/validation.json"}],documents:pending.documents}} />
</If>
</If>

</Loop>
