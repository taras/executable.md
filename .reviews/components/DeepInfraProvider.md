---
props:
  type: object
  properties:
    model:
      type: string
  required: [model]
  additionalProperties: false
---

```ts persist eval
import { env as runtimeEnv, fetch as runtimeFetch } from "@executablemd/runtime";

function* complete(context) {
  const token = yield* runtimeEnv("DEEPINFRA_TOKEN");
  if (!token) {
    throw new Error("DEEPINFRA_TOKEN is not configured");
  }

  const messages = [];
  if (context.system) {
    messages.push({ role: "system", content: context.system });
  }
  messages.push({ role: "user", content: context.content });

  const response = yield* runtimeFetch("https://api.deepinfra.com/v1/openai/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": ["Bearer", token].join(" "),
    },
    body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 4096 }),
  });
  const body = yield* response.text();
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`DeepInfra request failed (${response.status})`);
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
