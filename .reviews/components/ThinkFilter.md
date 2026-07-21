---
inputs:
  type: object
  properties: {}
  additionalProperties: false
---

```ts persist eval
yield* Sample.around({
  *sample([context], next) {
    const result = yield* next(context);
    return result.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/gi, "").trim();
  },
});
```

<Content />
