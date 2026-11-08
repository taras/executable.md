---
props:
  type: object
  properties:
    record: {type: string, minLength: 1}
    decision: {type: string, minLength: 1}
  required: [record, decision]
  additionalProperties: false
---
<Entry.ResolveDecision record={props.record} decision={props.decision} as="work" />
<Output><Json value={work} /></Output>
