---
inputs:
  pr:
    type: object
    required: true
  metric:
    type: string
    required: true
  op:
    type: string
    required: true
  value:
    type: number
    required: true
  severity: warning
  message:
    type: string
    required: true
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
