---
inputs:
  type: object
  properties:
    rows:
      type: array
      items:
        type: object
        properties:
          symbol:
            type: string
          line:
            type: number
            default: 0
          level:
            type: string
            enum: [info, warn]
            default: info
        required: [symbol]
        additionalProperties: false
  required: [rows]
  additionalProperties: false
---

```ts eval
return rows.map((row) => `${row.symbol}@${row.line}:${row.level}`).join(", ");
```
