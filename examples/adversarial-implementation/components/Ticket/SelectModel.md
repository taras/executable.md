---
description: >-
  Select the model of an unused original Implementor at a confirmed paused implementation
  handoff and publish the amended continuation without calling a role. Use
  <Ticket.SelectModel record={envelope} model="sonnet" evidence="/absolute/approval.md" as="selected" />,
  then continue the returned envelope normally.
props:
  type: object
  properties:
    record: {type: object}
    model: {type: string, minLength: 1}
    evidence: {type: string, pattern: '^/'}
  required: [record, model, evidence]
  additionalProperties: false
returns: {type: object}
---

The amendment covers one boundary: the confirmed, dispatchable, paused implementation
gate whose original Implementor has no initialization standing, no call of any status,
no identity receipt and no occupied next call reservation. The provider, sessions,
source anchor, captured inputs, call ordinals and consumed allowances stay as recorded.
The caller's authorization text enters the retained documents under a fresh reference
before a new continuation records the selection and links the one it replaces.

<Ticket.Load record={props.record} as="saved" />
<Let as="state" value={saved.checkpoint} />
<Let as="roles" value={saved.manifest.roles} />
<Let as="repository" value={saved.manifest.assignment.repository} />
<If condition={state.status !== "paused" || !state.dispatchable || state.gate !== "implementation" || state.hold !== null || roles.implementor.initialized || state.initialized.implementor || saved.calls.some(call => call.role === "implementor")}>
<Fail message="The Implementor model can change only at a confirmed paused implementation handoff before its first dispatch. Preserve this record and reconcile its current owner." />
</If>
<Let as="id" value={String(saved.calls.length).padStart(4,"0")} />
<Let as="identityPath" value={(saved.manifest.identityDirectory ?? saved.manifest.directory + "/sessions") + "/" + encodeURIComponent(roles.implementor.session) + ".json"} />
<Let as="unstartedPaths" value={[saved.manifest.directory + "/calls/" + id,saved.manifest.directory + "/attempts/" + id,saved.manifest.directory + "/preparations/" + id,identityPath,identityPath + ".mismatch.json"]} />
<Ticket.Unstarted paths={unstartedPaths} as="unstarted" />
<If condition={!unstarted}>
<Fail message="The Implementor model can change only at a confirmed paused implementation handoff before its first dispatch. Preserve this record and reconcile its current owner." />
</If>
<If condition={Object.hasOwn(saved.documents,props.evidence)}>
<Fail message={"A recorded reference keeps its first text; give the authorization a fresh reference instead of " + props.evidence + "."} />
</If>
<Ticket.Documents repository={repository} directory={saved.manifest.directory} paths={[props.evidence]} documents={saved.documents} as="documents" />
<Let as="candidate" value={{...saved,documents,manifest:{...saved.manifest,roles:{...roles,implementor:{...roles.implementor,model:props.model}},implementationModelSelection:{previousContinuation:props.record.continuation,previousModel:roles.implementor.model ?? null,model:props.model,evidence:documents[props.evidence]}}}} />
<Ticket.Capacity name="candidate" as="fits" />
<If condition={!fits}>
<Fail message="The amended continuation exceeds metadata capacity. Preserve the previous continuation; no selection was published." />
</If>
<Ticket.Publish record={candidate} previous={props.record} as="published" />
<If condition={published.publication === "confirmed"}>
<Return value={published} />
<Else><Return value={{...published,hold:"The model selection was not confirmed for publication. Preserve the previous continuation and reconcile before dispatch."}} /></Else>
</If>
