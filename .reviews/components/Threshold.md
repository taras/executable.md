---
inputs:
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
  totalChanges: pr.stats.totalChanges,
  totalFiles: pr.stats.totalFiles,
  additions: pr.stats.additions,
  deletions: pr.stats.deletions,
  directories: pr.directories.size,
};

const actual = metrics[metric];
const ops = {
  ">":  (a, b) => a > b,
  ">=": (a, b) => a >= b,
  "<":  (a, b) => a < b,
  "<=": (a, b) => a <= b,
  "==": (a, b) => a == b,
};

if (ops[op](actual, value)) {
  const icon = severity === "error" ? "\ud83d\udd34" : "\ud83d\udfe1";
  return icon + " " + message
    .replace("{actual}", String(actual))
    .replace("{value}", String(value));
}
```
