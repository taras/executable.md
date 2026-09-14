---
props:
  type: object
  properties:
    pr:
      type: object
    severity:
      type: string
      default: warning
    message:
      type: string
      default: "package.json changed without dependency justification."
  required: [pr]
  additionalProperties: false
---

```ts eval
const touchesPkg = props.pr.files.some(f =>
  f.path === "package.json" || f.path.endsWith("/package.json")
);
const mentionsDeps = props.pr.meta.body.toLowerCase().includes("dependenc");
const triggered = touchesPkg && !mentionsDeps;
```

<Finding when={triggered} severity={props.severity} message={props.message} />
