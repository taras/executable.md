---
meta:
  componentName: CooperativeProvider
---

```bash service=server exec
node packages/cli/tests/fixtures/cooperative-service.mjs normal smoke
```

```js persist ephemeral eval
const endpoint = server;
yield* Sample.around({
  *sample() {
    return `cooperative:${endpoint.hostname}:${Object.isFrozen(endpoint)}`;
  },
});
```

<Content />
