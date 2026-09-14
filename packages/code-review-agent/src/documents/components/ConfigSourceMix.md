---
props:
  type: object
  properties:
    pr:
      type: object
    minFiles:
      type: number
      default: 5
    severity:
      type: string
      default: warning
    message:
      type: string
      default: "PR mixes config and source changes."
  required: [pr]
  additionalProperties: false
---

```ts eval
const hasConfig = props.pr.files.some(f => f.isConfig);
const hasSource = props.pr.files.some(f =>
  !f.isConfig && !f.isTest && !f.isTypeDeclaration
);
const triggered = hasConfig && hasSource && props.pr.stats.totalFiles > props.minFiles;
```

<Finding when={triggered} severity={props.severity} message={props.message} />
