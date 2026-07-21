---
inputs:
  type: object
  properties:
    groups:
      type: array
    label:
      type: string
  required: [groups, label]
  additionalProperties: false
---

```ts eval
if (groups.length === 0) return;

const lines = groups.map(g =>
  `- \`${g.ruleId}\` ×${g.count}: ${g.files.slice(0, 3).join(", ")}${g.files.length > 3 ? ` (+${g.files.length - 3})` : ""}`
);

return `**Oxlint ${label}:**\n${lines.join("\n")}`;
```
