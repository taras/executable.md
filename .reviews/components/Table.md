---
inputs:
  type: object
  properties:
    headers:
      type: array
      items:
        type: string
    rows:
      type: array
      items:
        type: array
        items:
          type: string
  required: [headers, rows]
  additionalProperties: false
---

```ts eval
const head = `| ${headers.join(" | ")} |`;
const divider = `| ${headers.map(() => "---").join(" | ")} |`;
const body = rows.map(r => `| ${r.join(" | ")} |`).join("\n");
return [head, divider, body].join("\n");
```
