---
meta:
  componentName: AnthropicProvider

inputs:
  model:
    type: string
    required: true
    description: >
      Anthropic model identifier. Passed as the `model` field in every
      /v1/messages request and used as the routing key for sample calls.
      Requires ANTHROPIC_API_KEY environment variable to be set.
---

```ts persist eval
yield *
  Sample.around(
    {
      *sample([context], next) {
        if (context.model !== undefined && context.model !== model) {
          return yield* next(context);
        }

        const messages = [];
        if (context.system) {
          messages.push({ role: "system", content: context.system });
        }
        messages.push({ role: "user", content: context.content });

        const result = yield* fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": process.env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model,
            max_tokens: 4096,
            system: context.system || undefined,
            messages: [{ role: "user", content: context.content }],
          }),
        })
          .expect()
          .json();

        return result.content[0].text;
      },
    },
    { at: "min" },
  );
```

<Content />
