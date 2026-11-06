---
description: >-
  Continue an existing ticket through its next original role. Use
  <Ticket.Walk record={record} confirmed={confirmed} maxSteps={1} as="ticket" />.
props:
  type: object
  properties:
    record: {type: object}
    confirmed: {type: object}
    maxSteps: {type: integer, minimum: 1}
  required: [record, confirmed]
  additionalProperties: false
returns: {type: object}
---

Continue preserves original sessions, delivered inputs and the correction bound.
A held or completed checkpoint returns unchanged. Each Step joins before another
Step starts. Omitting maxSteps runs at most the initial Planner, Architect and
returned Planner journey, then the implementation loop. Further discovery pauses
with its prepared assignment. An explicit maxSteps bounds outstanding role calls.
An admitted delivery amendment publishes its final feedback beside its
reservation after the confirmed feedback_ready continuation; the original
`feedback.json` is never rewritten.

<Let as="record" value={props.record} />
<Let as="confirmed" value={props.confirmed} />
<Let as="stopped" value={false} />
<If condition={props.maxSteps === undefined}>
<Loop max={3}>
<If condition={stopped || !record.checkpoint.dispatchable || record.checkpoint.assignment.phase !== "discovery"}><Break /></If>
<Let as="discoveryCalls" value={record.calls.filter(call => call.assignment.phase === "discovery")} />
<If condition={discoveryCalls.length >= 3 || discoveryCalls.length === 1 && (discoveryCalls[0].role !== "planner" || record.checkpoint.gate !== "architect-discovery") || discoveryCalls.length === 2 && (discoveryCalls[1].role !== "architect" || record.checkpoint.gate !== "planning")}><Break /></If>
<Ticket.Step record={record} previous={confirmed} as="stepped" />
<Let as="confirmed" value={stepped.envelope} />
<If condition={confirmed.publication !== "confirmed"}><Let as="stopped" value={true} /><Break /></If>
<Let as="record" value={stepped.record} />
</Loop>
<Loop max={(record.manifest.maxCorrections + 1) * 5}>
<If condition={stopped || !record.checkpoint.dispatchable || record.checkpoint.assignment.phase === "discovery"}><Break /></If>
<Ticket.Step record={record} previous={confirmed} as="stepped" />
<Let as="confirmed" value={stepped.envelope} />
<If condition={confirmed.publication !== "confirmed"}><Let as="stopped" value={true} /><Break /></If>
<Let as="record" value={stepped.record} />
</Loop>
<If condition={!stopped && record.checkpoint.dispatchable && record.checkpoint.assignment.phase !== "discovery"}><Fail message="The correction bound ended without a settled gate." /></If>
</If>
<If condition={props.maxSteps !== undefined}>
<Loop max={props.maxSteps}>
<If condition={stopped || !record.checkpoint.dispatchable}><Break /></If>
<Ticket.Step record={record} previous={confirmed} as="stepped" />
<Let as="confirmed" value={stepped.envelope} />
<If condition={confirmed.publication !== "confirmed"}><Let as="stopped" value={true} /><Break /></If>
<Let as="record" value={stepped.record} />
</Loop>
</If>
<If condition={!stopped && record.checkpoint.dispatchable}><Let as="record" value={{...record,checkpoint:{...record.checkpoint,status:"paused",hold:null}}} /></If>
<If condition={stopped}><Return value={confirmed} /><Else>
<If condition={record.manifest.delivery !== undefined && record.checkpoint.amendment === undefined && record.checkpoint.status === "feedback_ready" && props.record.checkpoint.status !== "feedback_ready"}>
<Dir path={record.manifest.delivery.directory}><File path="feedback.json"><Json value={{status:record.checkpoint.status,revision:record.checkpoint.revision}} /></File></Dir>
</If>
<Let as="final" value={confirmed} />
<If condition={record.checkpoint.status !== confirmed.status}><Ticket.Publish record={record} previous={confirmed} as="final" /></If>
<If condition={record.checkpoint.amendment !== undefined && record.checkpoint.status === "feedback_ready" && final.publication === "confirmed"}><Ticket.AmendmentFeedback record={record} confirmed={final} as="finalFeedback" /></If>
<Return value={final} />
</Else></If>
