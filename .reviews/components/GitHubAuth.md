---
props:
  type: object
  properties: {}
  additionalProperties: false
---

```ts persist eval
import { API, env as runtimeEnv } from "@executablemd/runtime";

function* renderAuthenticatedContent() {
  const token = yield* runtimeEnv("GITHUB_TOKEN");
  if (token) {
    yield* API.Fetch.around({
      *fetch([input, init], next) {
        let url;
        try {
          url = new URL(input);
        } catch {
          return yield* next(input, init);
        }

        if (url.protocol !== "https:" || url.hostname !== "api.github.com") {
          return yield* next(input, init);
        }

        return yield* next(input, {
          ...init,
          headers: {
            ...(init?.headers ?? {}),
            "Accept": "application/vnd.github+json",
            "Authorization": ["Bearer", token].join(" "),
          },
        });
      },
    }, { at: "min" });
  }
}

yield* renderAuthenticatedContent();
```

<Content />
