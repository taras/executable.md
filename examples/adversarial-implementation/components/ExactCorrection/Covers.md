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
<Let as="ticket" value={props.record.checkpoint} />
<Let as="proof" value={ticket.exactReview} />
<Let as="calls" value={props.record.calls ?? []} />
<If condition={proof?.status !== "verified" || proof.approval?.role !== props.role}><Return value={false} /><Else>
<Let as="source" value={null} />
<Let as="candidates" value={calls.filter(call => call.role === "implementor" && call.status === "accepted")} />
<Let as="index" value={0} />
<If condition={candidates.length !== 0}>
<Loop max={candidates.length}>
<Let as="call" value={candidates[index]} />
<Ticket.Hydrate repository={props.record.manifest.assignment.repository} document={props.record.documents[call.result]} as="resultText" />
<Parse schema={{type:"object"}} as="result">{resultText.content}</Parse>
<Ticket.Hydrate repository={props.record.manifest.assignment.repository} document={props.record.documents[call.observation]} as="observationText" />
<Parse schema={{type:"object"}} as="observation">{observationText.content}</Parse>
<If condition={result.revision === ticket.revision && JSON.stringify(observation.exactReceipt) === JSON.stringify(proof)}><Let as="source" value={call} /><Break /></If>
<Let as="index" value={index + 1} />
</Loop>
</If>
<Let as="review" value={calls.find(call => call.role === props.role && call.status === "accepted" && call.result === proof.approval.result)} />
<Let as="reviewResult" value={null} />
<If condition={review !== undefined}>
<Ticket.Hydrate repository={props.record.manifest.assignment.repository} document={props.record.documents[review.result]} as="reviewText" />
<Parse schema={{type:"object"}} as="reviewResult">{reviewText.content}</Parse>
</If>
<Return value={proof?.status === "verified" && proof.revision === ticket.revision && proof.approval?.role === props.role && source !== null && review !== undefined && reviewResult?.outcome === "changes_required" && JSON.stringify(reviewResult.exactCorrection) === JSON.stringify(proof.approval.offer) && source.assignment.revision === proof.approval.offer.baseRevision && reviewResult.revision === proof.approval.offer.baseRevision && review.session === props.record.manifest?.roles?.[props.role]?.session && proof.after?.clean === true && proof.after.head === ticket.revision && proof.signature?.exitCode === 0 && proof.source?.exitCode === 0 && proof.source.stdout.trim() === ticket.revision + " " + proof.approval.offer.targetTree + " " + proof.approval.offer.baseRevision && proof.checks.length === proof.approval.offer.checks.length && proof.checks.every((check,index) => check.revision === ticket.revision && check.exitCode === 0 && check.name === proof.approval.offer.checks[index].name && JSON.stringify(check.argv) === JSON.stringify(proof.approval.offer.checks[index].argv))} />

</Else></If>
