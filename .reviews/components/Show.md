---
inputs:
  when:
    type: boolean
    required: true
  fallback: ""
---

```ts eval
if (when) {
  return yield* renderChildren();
}
if (fallback) {
  return fallback;
}
```
