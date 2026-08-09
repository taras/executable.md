---
props:
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
    if (context.model !== undefined && context.model !== props.model) {
      return yield* next(context);
    }

    const messages = [];
    if (context.system) {
      messages.push({ role: "system", content: context.system });
    }
    messages.push({ role: "user", content: context.content });

    const result = yield* fetch(`${props.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: props.model, messages, temperature: 0 }),
    })
      .expect()
      .json();

    const content = result.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("Ollama response did not contain model content");
    }
    return content;
  },
}, { at: 'min' });
```

<Content />
