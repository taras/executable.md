---
inputs:
  type: object
  properties:
    pr:
      type: object
    minLength:
      type: number
      default: 50
    severity:
      type: string
      default: error
    message:
      type: string
      default: "PR description must explain what and why."
  required: [pr]
  additionalProperties: false
---

<Finding when={pr.meta.body.length < minLength}
  severity={severity} message={message} />
