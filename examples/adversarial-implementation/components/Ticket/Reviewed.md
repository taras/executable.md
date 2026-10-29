---
description: >-
  Check that the required reviews cover this feedback commit. Use
  <Ticket.Reviewed record={ticket} as="reviewed" /> before delivery.
props:
  type: object
  properties:
    record: {type: object}
  required: [record]
  additionalProperties: false
returns: {type: boolean}
---
<Let as="ticket" value={props.record.checkpoint ?? props.record} />
<If condition={!ticket.reviewPolicy}><Fail message="This checkpoint has no recorded impact policy; continue it with its original workflow files." /></If>
<ReviewPolicy assessment={ticket.reviewPolicy.assessment} kind={ticket.reviewPolicy.kind} as="policy" />
<If condition={ticket.reviewPolicy.kind !== policy.kind || ticket.reviewPolicy.model !== policy.model || ticket.reviewPolicy.effort !== policy.effort || JSON.stringify(ticket.reviewPolicy.reviewers) !== JSON.stringify(policy.reviewers)}><Fail message="The recorded review policy differs from this workflow revision." /></If>
<Let as="covered" value={[]} />
<Let as="index" value={0} />
<If condition={policy.reviewers.length > 0}>
<Loop max={policy.reviewers.length}>
<Let as="role" value={policy.reviewers[index]} />
<ExactCorrection.Covers record={props.record} role={role} as="conditional" />
<Let as="covered" value={[...covered,ticket.reviews[role] === ticket.revision || policy.effort === "medium" && policy.reviewers.length === 1 && conditional]} />
<Let as="index" value={index + 1} />
</Loop>
</If>
<Return value={ticket.status === "feedback_ready" && covered.every(value => value)} />
