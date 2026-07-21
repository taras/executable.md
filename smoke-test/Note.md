---
emoji: "📝"

inputs:
  type: object
  properties:
    level:
      type: string
      default: info
    message:
      type: string
  required: [message]
  additionalProperties: false
---

> {meta.emoji} **{props.level}:** {props.message}
