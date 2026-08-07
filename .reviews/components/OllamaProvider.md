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
import { fetch as runtimeFetch } from "@executablemd/runtime";

function* complete(context) {
  const messages = [];
  if (context.system) {
    messages.push({ role: "system", content: context.system });
  }
  messages.push({ role: "user", content: context.content });

  const response = yield* runtimeFetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature: 0 }),
  });
  const body = yield* response.text();
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Ollama request failed (${response.status})`);
  }
  const result = JSON.parse(body);
  return result.choices?.[0]?.message?.content ?? "";
}

yield* Sample.around({
  *sample([context], next) {
    if (context.model !== undefined && context.model !== model) {
      return yield* next(context);
    }

    return yield* complete(context);
  },
}, { at: 'min' });
```

<Content />
