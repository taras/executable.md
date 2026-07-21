---
inputs:
  type: object
  properties:
    model:
      type: string
    baseUrl:
      type: string
      default: "http://localhost:11434"
  required: [model]
  additionalProperties: false
---

```ts persist eval
yield* Sample.around({
  *sample([context], next) {
    if (context.model !== undefined && context.model !== model) {
      return yield* next(context);
    }

    const messages = [];
    if (context.system) {
      messages.push({ role: "system", content: context.system });
    }
    messages.push({ role: "user", content: context.content });

    const result = yield* fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, temperature: 0 }),
    })
      .expect()
      .json();

    return result.choices[0].message.content;
  },
}, { at: 'min' });
```

<Content />
