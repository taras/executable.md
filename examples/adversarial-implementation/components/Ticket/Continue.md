---
description: >-
  Continue an existing ticket through its next original role. Use
  <Ticket.Continue record={ticket} maxSteps={1} as="ticket" />.
props:
  type: object
  properties:
    record: {type: object}
    maxSteps: {type: integer, minimum: 1}
  required: [record]
  additionalProperties: false
returns: {type: object}
---

Continue preserves original sessions, delivered inputs and the correction bound.
A held or completed checkpoint returns unchanged. Each Step joins before another
Step starts. Omitting maxSteps retains Run's initial bounded loop.

<Let as="record" value={props.record} />
<Loop max={props.maxSteps ?? (record.manifest.maxCorrections + 1) * 5}>
<If condition={!record.checkpoint.dispatchable}><Break /></If>
<Ticket.Step record={record} as="record" />
</Loop>
<If condition={props.maxSteps === undefined && record.checkpoint.dispatchable}><Fail message="The correction bound ended without a settled gate." /></If>
<If condition={record.manifest.delivery !== undefined}>
<Let as="delivery" value={record.manifest.delivery} />
<If condition={record.checkpoint.status === "feedback_ready" && props.record.checkpoint.status !== "feedback_ready"}><Dir path={delivery.directory}><File path="feedback.json"><Json value={{status:record.checkpoint.status,revision:record.checkpoint.revision}} /></File></Dir></If>
<Return value={{...record,...record.checkpoint,delivery:{...delivery,status:record.checkpoint.status === "feedback_ready" ? "review_pending" : "feedback_pending"},remainingRequiredDeliveryWork:delivery.required,nextAction:record.checkpoint.status === "feedback_ready" ? {entry:"delivery.md",record:delivery.directory + "/requirements.json",action:"review"} : {entry:"continue.md",gate:record.checkpoint.gate,action:record.checkpoint.dispatchable ? "continue_feedback" : "resolve_feedback_hold"}}} />
<Else><Return value={{...record,...record.checkpoint}} /></Else>
</If>
