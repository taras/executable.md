---
inputs: {}
---

```ts persist eval
yield* Sample.around({
  *sample([context], next) {
    const result = yield* next(context);
    return result.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  },
});
```

<Content />
