---
description: >-
  Select the original owner and continuation for a saved ticket gate.
  Use <Ticket.Gate record={record} as="selected" /> before invoking a role.
props:
  type: object
  properties:
    record: {type: object}
  required: [record]
  additionalProperties: false
returns: {type: object}
---

The recorded impact policy selects the reviewers. Each selected reviewer receives
the implementation result and Git observations. Corrections return to the original
Implementor; their actual impact selects the next required reviews.

<Let as="state" value={props.record.checkpoint} />
<ReviewPolicy assessment={state.assignment.assessment} kind={state.assignment.reviewKind ?? "feature"} as="policy" />
<Let as="gates" value={{
  implementation: {
    role: "implementor",
    continuation: policy.reviewers.length === 0 ? {phase:"ready",role:null} : {phase:"review",role:policy.reviewers[0]}
  },
  "architect-review": {
    role: "architect",
    continuation: state.reviewPolicy.reviewers.includes("planner") ? {phase:"review",role:"planner"} : {phase:"ready",role:null}
  },
  "planner-review": {
    role: "planner",
    continuation: {phase: "ready", role: null}
  }
}} />
<Let as="gate" value={gates[state.gate]} />
<If condition={gate === undefined}><Fail message="The saved ticket has no runnable gate." /></If>
<Let as="identity" value={props.record.manifest.roles[gate.role]} />
<Let as="id" value={String(props.record.calls.length).padStart(4,"0")} />
<Let as="attempt" value={props.record.manifest.directory + "/attempts/" + id} />
<Let as="assignment" value={{...state.assignment,request:state.assignment.request + (gate.role === "implementor" && state.exactApproval ? "\nApply only this reviewer-authorized patch, then create one signed child commit. The workflow executes its checks. Any deviation requires ordinary review.\n" + JSON.stringify(state.exactApproval.offer) : ""),artifactDirectory:attempt,gate:state.gate,handoffInputs:[...new Set([...(state.assignment.handoffInputs ?? []),...(gate.role === "implementor" ? [] : state.feedbackInputs ?? [])])],artifacts:[...new Set([...state.assignment.artifacts,...(gate.role === "implementor" ? [] : state.feedback)])],recipient:gate.role,continuation:gate.continuation}} />
<Return value={{call:{id,attempt,record:props.record.manifest.directory + "/calls/" + id,gate:state.gate,round:state.round,role:gate.role,session:identity.session,provider:identity.provider,initialize:!state.initialized[gate.role],assignment},checkpoint:{...state,status:"running",initialized:{...state.initialized,[gate.role]:true}}}} />
