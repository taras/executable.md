---
meta:
  componentName: StubProvider

inputs:
  type: object
  properties:
    model:
      type: string
  required: [model]
  additionalProperties: false
---

```js persist eval
yield* Sample.around({
  *sample([context], next) {
    if (context.model !== undefined && context.model !== model) {
      return yield* next(context);
    }
    const sys = context.system ? '|system:' + context.system : '';
    return '[response-from-' + model + sys + '|content:' + context.content + ']';
  },
}, { at: 'min' });
```

<Content />
