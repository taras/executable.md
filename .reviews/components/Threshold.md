---
props:
  type: object
  properties:
    pr:
      type: object
    metric:
      type: string
    op:
      type: string
    value:
      type: number
    severity:
      type: string
      default: warning
    message:
      type: string
  required: [pr, metric, op, value, message]
  additionalProperties: false
---

```ts eval
const metrics = {
  totalChanges: props.pr.stats.totalChanges,
  totalFiles: props.pr.stats.totalFiles,
  additions: props.pr.stats.additions,
  deletions: props.pr.stats.deletions,
  directories: Array.isArray(props.pr.directories) ? props.pr.directories.length : props.pr.directories.size,
};

const actual = metrics[props.metric];
const ops = {
  ">":  (a, b) => a > b,
  ">=": (a, b) => a >= b,
  "<":  (a, b) => a < b,
  "<=": (a, b) => a <= b,
  "==": (a, b) => a == b,
};

if (ops[props.op](actual, props.value)) {
  const icon = props.severity === "error" ? "\ud83d\udd34" : "\ud83d\udfe1";
  return icon + " " + props.message
    .replace("{actual}", String(actual))
    .replace("{value}", String(props.value));
}
```
