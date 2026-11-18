---
props:
  type: object
  properties:
    task: {type: string, minLength: 1}
    maxSteps: {type: integer, minimum: 1}
  required: [task]
  additionalProperties: false
---

<Entry.Run task={props.task} maxSteps={props.maxSteps} as="work" />
<Output><Json value={work} /></Output>
