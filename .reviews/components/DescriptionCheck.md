---
inputs:
  pr:
    type: object
    required: true
  minLength: 50
  severity: error
  message: "PR description must explain what and why."
---

<Finding when={pr.meta.body.length < minLength}
  severity={severity} message={message} />
