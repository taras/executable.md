---
meta:
  componentName: AnthropicProvider

inputs:
  model:
    type: string
    required: true
    enum:
      - claude-sonnet-4-5
      - claude-sonnet-4-5-20250929
      - claude-opus-4-5
      - claude-opus-4-5-20251101
      - claude-opus-4-1-20250805
      - claude-opus-4-0
      - claude-opus-4-20250514
      - claude-sonnet-4-0
      - claude-sonnet-4-20250514
      - claude-haiku-4-5
      - claude-haiku-4-5-20251001
      - claude-3-5-haiku-latest
      - claude-3-5-haiku-20241022
      - claude-3-opus-latest
      - claude-3-opus-20240229
    description: >
      Anthropic model identifier. Passed as the `model` field in every
      /v1/messages request and used as the routing key for sample calls.
      Requires ANTHROPIC_API_KEY environment variable to be set.
---

```ts persist eval
yield* Sample.around({
  *sample([context], next) {
    if (context.model !== undefined && context.model !== model) {
      return yield* next(context);
    }
    return yield* callAnthropic(model, context);
  },
}, { at: 'min' });
```

<Content />
