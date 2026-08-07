---
props:
  type: object
  properties:
    files:
      type: array
      items:
        type: string
  required: [files]
  additionalProperties: false
---

```ts eval
return props.files.join(", ");
```
