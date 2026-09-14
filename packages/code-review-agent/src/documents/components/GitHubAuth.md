---
props:
  type: object
  properties: {}
  additionalProperties: false
---

```ts persist eval
import { FetchApi } from "@effectionx/fetch";
import { env as runtimeEnv } from "@executablemd/runtime";

function* installGitHubAuth() {
  const token = yield* runtimeEnv("GITHUB_TOKEN");
  if (!token) {
    return;
  }
  yield* FetchApi.around({
    *fetch([input, init, shouldExpect], next) {
      let url;
      try {
        url = input instanceof Request ? new URL(input.url) : new URL(input);
      } catch {
        return yield* next(input, init, shouldExpect);
      }

      if (url.protocol !== "https:" || url.hostname !== "api.github.com") {
        return yield* next(input, init, shouldExpect);
      }

      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      const requestHeaders = new Headers(init?.headers);
      requestHeaders.forEach((value, key) => headers.set(key, value));
      headers.set("Authorization", `Bearer ${token}`);
      if (!headers.has("Accept")) {
        headers.set("Accept", "application/vnd.github+json");
      }

      return yield* next(input, { ...init, headers }, shouldExpect);
    },
  });
}

yield* installGitHubAuth();
```

<Content />
