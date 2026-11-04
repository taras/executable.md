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
Step starts. Omitting maxSteps runs at most the initial Planner, Architect and
returned Planner journey, then the implementation loop. Further discovery pauses
with its prepared assignment. An explicit maxSteps bounds outstanding role calls.

<Let as="record" value={props.record} />
<If condition={props.maxSteps === undefined}>
<Loop max={3}>
<If condition={!record.checkpoint.dispatchable || record.checkpoint.assignment.phase !== "discovery"}><Break /></If>
<Let as="discoveryCalls" value={record.calls.filter(call => call.assignment.phase === "discovery")} />
<If condition={discoveryCalls.length >= 3 || discoveryCalls.length === 1 && (discoveryCalls[0].role !== "planner" || record.checkpoint.gate !== "architect-discovery") || discoveryCalls.length === 2 && (discoveryCalls[1].role !== "architect" || record.checkpoint.gate !== "planning")}><Break /></If>
<Ticket.Step record={record} as="record" />
</Loop>
<Loop max={(record.manifest.maxCorrections + 1) * 5}>
<If condition={!record.checkpoint.dispatchable || record.checkpoint.assignment.phase === "discovery"}><Break /></If>
<Ticket.Step record={record} as="record" />
</Loop>
<If condition={record.checkpoint.dispatchable && record.checkpoint.assignment.phase !== "discovery"}><Fail message="The correction bound ended without a settled gate." /></If>
</If>
<If condition={props.maxSteps !== undefined}>
<Loop max={props.maxSteps}>
<If condition={!record.checkpoint.dispatchable}><Break /></If>
<Ticket.Step record={record} as="record" />
</Loop>
</If>
<If condition={record.checkpoint.dispatchable}><Let as="record" value={{...record,checkpoint:{...record.checkpoint,status:"paused",hold:null}}} /></If>
<If condition={record.manifest.delivery !== undefined}>
<Let as="delivery" value={record.manifest.delivery} />
<If condition={record.checkpoint.status === "feedback_ready" && props.record.checkpoint.status !== "feedback_ready"}><Dir path={delivery.directory}><File path="feedback.json"><Json value={{status:record.checkpoint.status,revision:record.checkpoint.revision}} /></File></Dir></If>
<Return value={{...record,...record.checkpoint,delivery:{...delivery,status:record.checkpoint.status === "feedback_ready" ? "review_pending" : "feedback_pending"},remainingRequiredDeliveryWork:delivery.required,nextAction:record.checkpoint.status === "feedback_ready" ? {entry:"delivery.md",record:delivery.directory + "/requirements.json",action:"review"} : {entry:"continue.md",gate:record.checkpoint.gate ?? null,action:record.checkpoint.dispatchable ? "continue_feedback" : "resolve_feedback_hold"}}} />
<Else><Return value={{...record,...record.checkpoint,nextAction:{entry:"continue.md",gate:record.checkpoint.gate ?? null,action:record.checkpoint.dispatchable ? "continue_feedback" : "resolve_feedback_hold"}}} /></Else>
</If>
