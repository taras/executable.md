---
meta:
  componentName: AttachedPingPongProvider
---

```bash service=ping exec
node packages/cli/tests/fixtures/attached-service.mjs ping-pong ping
```

```bash service=pong exec
node packages/cli/tests/fixtures/attached-service.mjs ping-pong pong
```

```js persist ephemeral eval
const pingEndpoint = ping;
const pongEndpoint = pong;
if (
  pingEndpoint.hostname === pongEndpoint.hostname &&
  pingEndpoint.port === pongEndpoint.port
) {
  throw new Error("ping and pong attachments must have distinct endpoints");
}
yield* Sample.around({
  *sample() {
    const peerHostname = encodeURIComponent(pongEndpoint.hostname);
    const peerPort = encodeURIComponent(String(pongEndpoint.port));
    const response = yield* fetch(
      `http://${pingEndpoint.hostname}:${pingEndpoint.port}/?peerHostname=${peerHostname}&peerPort=${peerPort}&origin=ping`,
    ).expect();
    return yield* response.text();
  },
});
```

<Content />
