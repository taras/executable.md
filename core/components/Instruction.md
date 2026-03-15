---
meta:
  componentName: Instruction

inputs:
  text:
    type: string
    required: true
    description: >
      Instruction text to add to the Sample context. When Sample calls
      are made within this component's children, the instruction text
      is included in the SampleContext.instructions field, which
      replaces the default system prompt in buildDefaultMessages.
      Multiple Instruction components accumulate — instructions from
      enclosing scopes appear first, inner instructions are appended.
      Use as a wrapper (<Instruction text="...">children</Instruction>)
      or self-closing before <Content /> in agent components
      (<Instruction text="..." /> then <Content />).
---

```js persist eval
yield* Sample.around({
  *sample([context], next) {
    const existing = context.instructions || '';
    return yield* next({
      ...context,
      instructions: existing ? existing + '\n' + text : text,
    });
  },
}, { at: 'min' });
```

<Content />
