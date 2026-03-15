---
meta:
  componentName: LlamafileProvider

inputs:
  model:
    type: string
    required: true
    description: >
      Model identifier. Serves two purposes: it is passed as the `model` field
      in every /v1/chat/completions request, and it is the routing key that
      sample calls use to target this provider. Must be unique among all
      LlamafileProvider instances active simultaneously in the same document run.
      Example: "phi3-mini", "qwen3-0.6b"
  command:
    type: string
    required: true
    description: >
      Shell command to start the llamafile or llama.cpp server.
      {port} is substituted with the allocated port number before execution.
      Example: "./phi3-mini.llamafile --nobrowser"
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
    return yield* callLlamafile(baseUrl, model, context);
  },
}, { at: 'min' });
```

<Content />
