---
inputs:
  greeting:
    type: string
    required: true
  subject:
    type: string
    required: true
---

The caller said: "{props.greeting}, {props.subject}!"

<Note message="Props were successfully passed through to this component." />
