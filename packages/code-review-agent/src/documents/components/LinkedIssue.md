---
props:
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
description: >-
  Ask a large change to link an issue. `<LinkedIssue pr={pr} whenLinesExceed={200} />`
  reports when the description names no issue and the change is bigger than that.
---

```ts eval
const hasIssue = /(?:#\d+|https:\/\/github\.com\/.*\/issues\/\d+)/.test(props.pr.meta.body);
```

<Finding when={!hasIssue && props.pr.stats.totalChanges > props.whenLinesExceed}
  severity={props.severity} message={props.message} />
