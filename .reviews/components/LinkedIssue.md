---
inputs:
  type: object
  properties:
    pr:
      type: object
    whenLinesExceed:
      type: number
      default: 0
    severity:
      type: string
      default: warning
    message:
      type: string
      default: "Large PR with no linked issue."
  required: [pr]
  additionalProperties: false
---

```ts eval
const hasIssue = /(?:#\d+|https:\/\/github\.com\/.*\/issues\/\d+)/.test(pr.meta.body);
```

<Finding when={!hasIssue && pr.stats.totalChanges > whenLinesExceed}
  severity={severity} message={message} />
