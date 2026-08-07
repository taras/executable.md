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
---

```ts eval
const icon = props.severity === "error" ? "\ud83d\udd34" : "\ud83d\udfe1";
```

<Show when={props.when}>

{icon} {props.message}

</Show>
