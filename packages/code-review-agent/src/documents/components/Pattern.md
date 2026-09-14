---
props:
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
description: >-
  Report added lines matching a regular expression. `<Pattern pr={pr}
  pattern="console\.log\(" message="{count} console statements." />` renders once at
  least `min` lines match, and substitutes the count into `{count}`. Test files are
  excluded unless `excludeTests` says otherwise.
---

```ts eval
const re = new RegExp(props.pattern, "g");
const lines = props.excludeTests
  ? props.pr.added.filter(l => !l.isTest)
  : props.pr.added;
const matches = lines.filter(l => re.test(l.content));
re.lastIndex = 0;

if (matches.length >= props.min) {
  const icon = props.severity === "error" ? "\ud83d\udd34" : "\ud83d\udfe1";
  return icon + " " + props.message
    .replace("{count}", String(matches.length));
}
```
