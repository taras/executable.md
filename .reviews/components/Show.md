---
inputs:
  type: object
  properties:
    when:
      type: boolean
    fallback:
      type: string
      default: ""
  required: [when]
  additionalProperties: false
---

```ts eval
if (when) {
  return yield* renderChildren();
}
if (fallback) {
  return fallback;
}
```
