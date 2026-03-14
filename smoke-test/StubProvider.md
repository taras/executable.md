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
    const instr = context.instructions ? '|instructions:' + context.instructions : '';
    return '[response-from-' + model + instr + ']';
  },
}, { at: 'min' });
```

<Content />
