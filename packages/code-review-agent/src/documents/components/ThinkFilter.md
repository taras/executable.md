---
props:
  type: object
  properties: {}
  additionalProperties: false
description: >-
  Drop a model's reasoning from its answers. `<ThinkFilter>…</ThinkFilter>` removes
  `<think>` blocks from every `<Sample>` reply inside it, including an unterminated
  one.
context: >-
  The Markdown whose samples are filtered.
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
