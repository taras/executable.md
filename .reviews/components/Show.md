---
props:
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
if (props.when) {
  return yield* renderChildren();
}
if (props.fallback) {
  return props.fallback;
}
```
