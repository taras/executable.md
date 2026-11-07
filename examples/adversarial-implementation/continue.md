---
props:
  type: object
  properties:
    record: {type: string, minLength: 1}
    steps: {type: integer, minimum: 1, default: 1}
  required: [record]
  additionalProperties: false
---
<Entry.Continue record={props.record} steps={props.steps} as="work" />
<Output><Json value={work} /></Output>
