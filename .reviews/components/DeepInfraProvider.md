---
inputs:
  type: object
  properties:
    model:
      type: string
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

    const result = yield* fetch("https://api.deepinfra.com/v1/openai/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.DEEPINFRA_TOKEN}`,
      },
      body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 4096 }),
    })
      .expect()
      .json();

    return result.choices[0].message.content;
  },
}, { at: 'min' });
```

<Content />
