---
meta:
  componentName: StubProvider

inputs:
  model:
    type: string
    required: true
---

```js persist eval
yield* Sample.around({
  *sample([context], next) {
    if (context.model !== undefined && context.model !== model) {
      return yield* next(context);
    }
    return '[response-from-' + model + ']';
  },
}, { at: 'min' });
```

<Content />
