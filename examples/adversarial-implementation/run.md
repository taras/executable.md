---
props:
  type: object
  properties:
    task: {type: string, minLength: 1}
  required: [task]
  additionalProperties: false
---

<Entry.Run task={props.task} as="work" />
<Output><Json value={work} /></Output>
