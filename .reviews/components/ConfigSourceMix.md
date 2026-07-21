---
inputs:
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
const hasConfig = pr.files.some(f => f.isConfig);
const hasSource = pr.files.some(f =>
  !f.isConfig && !f.isTest && !f.isTypeDeclaration
);
const triggered = hasConfig && hasSource && pr.stats.totalFiles > minFiles;
```

<Finding when={triggered} severity={severity} message={message} />
