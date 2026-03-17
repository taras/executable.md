---
inputs:
  pr:
    type: object
    required: true
  pattern:
    type: string
    required: true
  min: 1
  excludeTests: true
  severity: warning
  message:
    type: string
    required: true
---

```ts eval
const re = new RegExp(pattern, "g");
const lines = excludeTests
  ? pr.added.filter(l => !l.isTest)
  : pr.added;
const matches = lines.filter(l => re.test(l.content));
re.lastIndex = 0;

if (matches.length >= min) {
  const icon = severity === "error" ? "\ud83d\udd34" : "\ud83d\udfe1";
  return icon + " " + message
    .replace("{count}", String(matches.length));
}
```
