---
props:
  type: object
  properties:
    when:
      type: boolean
    severity:
      type: string
      default: warning
    message:
      type: string
  required: [when, message]
  additionalProperties: false
description: >-
  Report one review finding. `<Finding when={tooLarge} severity="error" message="Split
  this PR." />` renders a severity icon and the message when `when` holds, and nothing
  when it does not — so a rule can be written unconditionally and stay quiet.
---

```ts eval
const icon = props.severity === "error" ? "\ud83d\udd34" : "\ud83d\udfe1";
```

<If condition={props.when}>

{icon} {props.message}

</If>
