---
meta:
  componentName: OllamaProvider

inputs:
  model:
    type: string
    required: true
    description: >
      Model identifier. Passed as the `model` field in every
      /v1/chat/completions request and used as the routing key for
      sample calls. Must match an Ollama model name that has been
      pulled locally (e.g., "llama3.2", "phi3", "qwen2.5").
---

```ts eval
const port = yield* findFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
```

```bash daemon exec
OLLAMA_HOST=127.0.0.1:{port} ollama serve
```

```ts eval
yield* when(function* () {
  yield* fetch(`${baseUrl}/api/tags`).expect();
});
```

```ts persist eval
yield* Sample.around({
  *sample([context], next) {
    if (context.model !== undefined && context.model !== model) {
      return yield* next(context);
    }
    return yield* callOllama(baseUrl, model, context);
  },
}, { at: 'min' });
```

<Content />
