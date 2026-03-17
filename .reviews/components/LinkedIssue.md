---
inputs:
  pr:
    type: object
    required: true
  whenLinesExceed: 0
  severity: warning
  message: "Large PR with no linked issue."
---

```ts eval
const hasIssue = /(?:#\d+|https:\/\/github\.com\/.*\/issues\/\d+)/.test(pr.meta.body);
```

<Finding when={!hasIssue && pr.stats.totalChanges > whenLinesExceed}
  severity={severity} message={message} />
