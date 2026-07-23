---
meta:
  componentName: LlamafileProvider

inputs:
  type: object
  properties:
    model:
      type: string
      description: >
        Model identifier. Serves two purposes: it is passed as the `model` field
        in every /v1/chat/completions request, and it is the routing key that
        sample calls use to target this provider. Must be unique among all
        LlamafileProvider instances active simultaneously in the same document run.
        Example: "phi3-mini", "qwen3-0.6b"
    command:
      type: string
      description: >
        Shell command to start the llamafile or llama.cpp server.
        {port} is substituted with the allocated port number before execution.
        Example: "./phi3-mini.llamafile --nobrowser"
  required: [model, command]
  additionalProperties: false
---

```ts eval
const port = yield* findFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
```

```bash daemon exec
{command} --port {port}
```

```ts eval
yield* when(function* () {
  yield* fetch(`${baseUrl}/health`).expect();
});
```

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
      body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 2048 }),
    })
      .expect()
      .json();

    return result.choices[0].message.content;
  },
}, { at: 'min' });
```

<Content />
