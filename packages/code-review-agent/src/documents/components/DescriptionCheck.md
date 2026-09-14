---
props:
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
description: >-
  Require a pull-request description that explains the change. `<DescriptionCheck
  pr={pr} minLength={50} />` reports a body shorter than `minLength`.
---

<Finding when={props.pr.meta.body.length < props.minLength}
  severity={props.severity} message={props.message} />
