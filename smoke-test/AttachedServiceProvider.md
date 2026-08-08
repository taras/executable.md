---
meta:
  componentName: AttachedServiceProvider
---

```bash service=server exec
node packages/cli/tests/fixtures/attached-service.mjs normal smoke
```

```js persist ephemeral eval
const endpoint = server;
yield* Sample.around({
  *sample() {
    return `attached:${endpoint.hostname}:${Object.isFrozen(endpoint)}`;
  },
});
```

<Content />
