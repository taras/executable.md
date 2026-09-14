---
props:
  type: object
  properties:
    groups:
      type: array
    label:
      type: string
  required: [groups, label]
  additionalProperties: false
description: >-
  List one category of Oxlint diagnostics. `<OxlintSignals
  groups={diagnostics.byCategory.verbosity} label="slop signals" />` names each rule
  with how often it fired and the first few files, and renders nothing when the
  category is empty.
---

```ts eval
if (props.groups.length === 0) return;

const lines = props.groups.map(g =>
  `- \`${g.ruleId}\` ×${g.count}: ${g.files.slice(0, 3).join(", ")}${g.files.length > 3 ? ` (+${g.files.length - 3})` : ""}`
);

return `**Oxlint ${props.label}:**\n${lines.join("\n")}`;
```
