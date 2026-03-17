---
inputs:
  pr:
    type: object
    required: true
  severity: warning
  message: "package.json changed without dependency justification."
---

```ts eval
const touchesPkg = pr.files.some(f =>
  f.path === "package.json" || f.path.endsWith("/package.json")
);
const mentionsDeps = pr.meta.body.toLowerCase().includes("dependenc");
const triggered = touchesPkg && !mentionsDeps;
```

<Finding when={triggered} severity={severity} message={message} />
