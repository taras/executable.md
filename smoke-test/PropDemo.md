---
inputs:
  type: object
  properties:
    greeting:
      type: string
    subject:
      type: string
  required: [greeting, subject]
  additionalProperties: false
---

The caller said: "{props.greeting}, {props.subject}!"

<Note message="Props were successfully passed through to this component." />
