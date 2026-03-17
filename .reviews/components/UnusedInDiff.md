---
inputs:
  pr:
    type: object
    required: true
  construct:
    type: string
    required: true
  severity: warning
  message:
    type: string
    required: true
---

```ts eval
const declPattern = new RegExp(
  `(?:${construct})\\s+(\\w+)`, "g"
);
const source = pr.added.map(l => l.content).join("\n");

const names = [];
let match;
while ((match = declPattern.exec(source)) !== null) {
  names.push(match[1]);
}

const unused = names.filter(name => {
  const refs = (source.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
  return refs <= 1;
});

if (unused.length > 0) {
  const icon = severity === "error" ? "\ud83d\udd34" : "\ud83d\udfe1";
  return icon + " " + message
    .replace("{names}", unused.join(", "))
    .replace("{count}", String(unused.length));
}
```
