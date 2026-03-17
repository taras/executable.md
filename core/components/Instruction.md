---
meta:
  componentName: Instruction

inputs:
  text:
    type: string
    required: true
    description: >
      Instruction text to set as the system prompt. When Sample calls
      are made within this component's children, the instruction text
      is included in the SampleContext.system field, which providers
      use as the system prompt. Multiple Instruction components
      accumulate — instructions from enclosing scopes appear first,
      inner instructions are appended.
---

```js persist eval
yield* Sample.around({
  *sample([context], next) {
    const existing = context.system || '';
    return yield* next({
      ...context,
      system: existing ? existing + '\n' + text : text,
    });
  },
}, { at: 'min' });
```

<Content />
