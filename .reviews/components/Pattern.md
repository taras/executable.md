---
inputs:
  type: object
  properties:
    pr:
      type: object
    pattern:
      type: string
    min:
      type: number
      default: 1
    excludeTests:
      type: boolean
      default: true
    severity:
      type: string
      default: warning
    message:
      type: string
  required: [pr, pattern, message]
  additionalProperties: false
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
