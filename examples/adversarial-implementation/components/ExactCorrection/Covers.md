---
description: >-
  Check a retained exact-correction receipt before delivery. Use
  <ExactCorrection.Covers record={ticket} role="planner" as="covered" />.
props:
  type: object
  properties:
    record: {type: object}
    role: {enum: [architect, planner]}
  required: [record, role]
  additionalProperties: false
returns: {type: boolean}
---
<Let as="ticket" value={props.record.checkpoint ?? props.record} />
<Let as="proof" value={ticket.exactReview} />
<Let as="calls" value={props.record.calls ?? []} />
<Let as="source" value={calls.find(call => call.role === "implementor" && call.status === "accepted" && call.resultValue?.revision === ticket.revision && JSON.stringify(call.observationValue?.exactReceipt) === JSON.stringify(proof))} />
<Let as="review" value={calls.find(call => call.role === props.role && call.status === "accepted" && call.result === proof?.approval?.result && call.resultValue?.outcome === "changes_required" && JSON.stringify(call.resultValue?.exactCorrection) === JSON.stringify(proof?.approval?.offer))} />
<Return value={proof?.status === "verified" && proof.revision === ticket.revision && proof.approval?.role === props.role && source !== undefined && review !== undefined && source.assignment.revision === proof.approval.offer.baseRevision && review.resultValue.revision === proof.approval.offer.baseRevision && review.session === props.record.manifest?.roles?.[props.role]?.session && proof.after?.clean === true && proof.after.head === ticket.revision && proof.signature?.exitCode === 0 && proof.source?.exitCode === 0 && proof.source.stdout.trim() === ticket.revision + " " + proof.approval.offer.targetTree + " " + proof.approval.offer.baseRevision && proof.checks.length === proof.approval.offer.checks.length && proof.checks.every((check,index) => check.revision === ticket.revision && check.exitCode === 0 && check.name === proof.approval.offer.checks[index].name && JSON.stringify(check.argv) === JSON.stringify(proof.approval.offer.checks[index].argv))} />
