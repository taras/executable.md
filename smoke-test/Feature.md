---
inputs:
  type: object
  properties:
    title:
      type: string
    description:
      type: string
  required: [title, description]
  additionalProperties: false
---

**{props.title}** — {props.description}

<Note message="This note was generated inside the Feature component." />
