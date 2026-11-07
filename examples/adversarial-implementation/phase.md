---
props:
  type: object
  properties:
    request: {type: string, minLength: 1}
  required: [request]
  additionalProperties: false
---

<Entry.Phase request={props.request} as="work" />
<Output><Json value={work} /></Output>
