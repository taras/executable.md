---
inputs:
  type: object
  properties:
    pr:
      type: object
    construct:
      type: string
    severity:
      type: string
      default: warning
    message:
      type: string
  required: [pr, construct, message]
  additionalProperties: false
---

```ts eval
const declPattern = new RegExp(
  `(?:${construct})\\s+(\\w+)`, "g"
);
const lines = pr.added.filter(l =>
  l.file.endsWith(".ts") || l.file.endsWith(".tsx")
);
const source = lines.map(l => l.content).join("\n");

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
