---
description: >-
  Apply a validated outcome to the ticket's review sequence and correction bound.
  Use <Ticket.Advance pending={pending} result={result} observation={facts} as="checkpoint" />.
props:
  type: object
  properties:
    pending: {type: object}
    result: {type: object}
    observation: {type: object}
  required: [pending, result, observation]
  additionalProperties: false
returns: {type: object}
---

A decision or contract conflict holds the ticket for its existing approval gate.
A correction clears prior verdicts. Readiness requires every selected reviewer to
PASS the same signed implementation SHA; it does not authorize delivery or merge.

<Let as="state" value={props.pending.checkpoint} />
<Let as="result" value={props.result} />
<Let as="call" value={props.pending.call} />
<Let as="correction" value={result.outcome === "changes_required" || result.outcome === "missing_evidence"} />
<Let as="round" value={state.round + (correction ? 1 : 0)} />
<Let as="held" value={["blocked","needs_decision","needs_discovery"].includes(result.outcome) || correction && round > props.pending.manifest.maxCorrections} />
<ReviewPolicy assessment={result.assessment ?? state.assignment.assessment} kind={correction ? "correction" : state.assignment.reviewKind ?? "feature"} as="assessed" />
<Let as="reviewPolicy" value={call.role === "implementor" || correction || result.outcome === "escalate" ? assessed : state.reviewPolicy} />
<Let as="reviews" value={correction || call.role === "implementor" ? {} : result.outcome === "pass" ? {...state.reviews,[call.role]:result.revision} : state.reviews} />
<Let as="revision" value={result.outcome === "complete" && call.role === "implementor" ? result.revision : state.revision} />
<Let as="exactApproval" value={correction ? props.observation.exactApproval ?? null : call.role === "implementor" ? null : state.exactApproval ?? null} />
<Let as="exactReview" value={call.role === "implementor" ? props.observation.exactReceipt?.status === "verified" && reviewPolicy.effort === "medium" && reviewPolicy.reviewers.length === 1 && reviewPolicy.reviewers[0] === props.observation.exactReceipt.approval.role ? props.observation.exactReceipt : null : correction ? null : state.exactReview ?? null} />
<Let as="remaining" value={reviewPolicy.reviewers.filter(role => reviews[role] !== revision && !(exactReview?.approval.role === role && exactReview.revision === revision))} />
<Let as="ready" value={!held && !correction && ["pass","complete"].includes(result.outcome) && remaining.length === 0} />
<Let as="gate" value={held || result.outcome === "escalate" ? state.gate : correction ? "implementation" : ready ? "feedback-ready" : remaining[0] + "-review"} />
<Let as="status" value={held ? "hold" : ready ? "feedback_ready" : props.pending.execution.status === "failed" ? "paused" : "running"} />
<Let as="assignment" value={{...props.pending.manifest.assignment,phase:gate === "implementation" ? "implementation" : "review",assessment:reviewPolicy.assessment,reviewKind:reviewPolicy.kind,revision,priorRevision:props.pending.manifest.assignment.revision,request:result.handoff,handoffInputs:result.handoffInputs ?? [],changedPaths:props.observation.changedPaths,artifacts:[...result.artifacts,props.observation.path],evidence:result.evidence,findings:result.findings,contract:result.contract ?? props.pending.manifest.assignment.contract ?? null}} />
<Return value={{...state,status,dispatchable:!held && !ready && props.pending.execution.status !== "failed",round,gate,revision,reviews,reviewPolicy,exactApproval,exactReview,assignment,feedbackInputs:result.outcome === "complete" && call.role === "implementor" ? result.handoffInputs ?? [] : state.feedbackInputs ?? [],discovery:[...(state.discovery ?? []),...((result.discoveryRequests?.length ?? 0) + (result.discoveryGaps?.length ?? 0) > 0 ? [{role:call.role,revision:result.revision,result:props.pending.resultPath,requests:result.discoveryRequests ?? [],gaps:result.discoveryGaps ?? []}] : [])],feedback:result.outcome === "complete" && call.role === "implementor" ? [props.pending.resultPath,props.observation.path] : state.feedback,hold:held ? {kind:correction ? "correction_bound" : result.outcome,reason:result.handoff} : null}} />
