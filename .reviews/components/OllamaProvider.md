---
inputs:
  model:
    type: string
    required: true
  baseUrl: "http://localhost:11434"
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

    let selectedModel = model;
    try {
      const tags = yield* fetch(`${baseUrl}/api/tags`).expect().json();
      const available = Array.isArray(tags?.models)
        ? tags.models
          .map((m) => typeof m?.name === "string" ? m.name : "")
          .filter(Boolean)
        : [];

      if (available.length > 0 && !available.includes(model)) {
        selectedModel = available[0];
      }
    } catch {
      // Keep requested model if tag discovery is unavailable.
    }

    const result = yield* fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: selectedModel, messages, temperature: 0 }),
    })
      .expect()
      .json();

    return result.choices[0].message.content;
  },
}, { at: 'min' });
```

<Content />
