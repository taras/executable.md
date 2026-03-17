---
inputs:
  when:
    type: boolean
    required: true
  severity: warning
  message:
    type: string
    required: true
---

```ts eval
const icon = severity === "error" ? "\ud83d\udd34" : "\ud83d\udfe1";
```

<Show when={when}>

{icon} {message}

</Show>
