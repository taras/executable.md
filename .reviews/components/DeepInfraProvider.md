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
import { env as runtimeEnv } from "@executablemd/runtime";

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
    const token = yield* runtimeEnv("DEEPINFRA_TOKEN");
    if (!token) {
      throw new Error("DeepInfraProvider requires DEEPINFRA_TOKEN");
    }

    const result = yield* fetch("https://api.deepinfra.com/v1/openai/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 4096 }),
    })
      .expect()
      .json();

    const content = result.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("DeepInfra response did not contain model content");
    }
    return content;
  },
}, { at: 'min' });
```

<Content />
