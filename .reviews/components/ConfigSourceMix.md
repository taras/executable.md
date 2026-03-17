---
inputs:
  pr:
    type: object
    required: true
  minFiles: 5
  severity: warning
  message: "PR mixes config and source changes."
---

```ts eval
const hasConfig = pr.files.some(f => f.isConfig);
const hasSource = pr.files.some(f =>
  !f.isConfig && !f.isTest && !f.isTypeDeclaration
);
const triggered = hasConfig && hasSource && pr.stats.totalFiles > minFiles;
```

<Finding when={triggered} severity={severity} message={message} />
