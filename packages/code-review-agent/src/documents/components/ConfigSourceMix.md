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
description: >-
  Flag a change that mixes configuration and source edits. `<ConfigSourceMix pr={pr}
  minFiles={5} />` reports when both appear in a pull request larger than `minFiles`.
---

```ts eval
const hasConfig = props.pr.files.some(f => f.isConfig);
const hasSource = props.pr.files.some(f =>
  !f.isConfig && !f.isTest && !f.isTypeDeclaration
);
const triggered = hasConfig && hasSource && props.pr.stats.totalFiles > props.minFiles;
```

<Finding when={triggered} severity={props.severity} message={props.message} />
