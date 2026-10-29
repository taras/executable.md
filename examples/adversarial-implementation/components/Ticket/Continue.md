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
<Return value={{...record,...record.checkpoint}} />
