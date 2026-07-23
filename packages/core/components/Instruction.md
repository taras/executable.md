---
meta:
  componentName: Instruction

inputs:
  type: object
  properties:
    system:
      type: string
      description: >
        System prompt text. When Sample calls are made within this
        component's children, the text is included in the
        SampleContext.system field, which providers use as the system
        prompt. Multiple Instruction components accumulate — instructions
        from enclosing scopes appear first, inner instructions are appended.
  required: [system]
  additionalProperties: false
---

```js persist eval
yield* Sample.around({
  *sample([context], next) {
    const existing = context.system || '';
    return yield* next({
      ...context,
      system: existing ? existing + '\n' + system : system,
    });
  },
}, { at: 'min' });
```

<Content />
