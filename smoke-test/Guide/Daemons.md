<Section title="Background Processes">

The `daemon` modifier starts a long-running process that survives across
subsequent blocks. Combined with `when()` for readiness polling, this
implements the provider pattern: start a service, wait until it's ready,
then run children against it.

The eval block below allocates a port, the daemon block starts a Node
HTTP server on it, and the readiness block polls until the server
responds:

```js eval
const daemonPort = yield * findFreePort();
const daemonUrl = "http://127.0.0.1:" + daemonPort;
```

```bash daemon exec
node -e "require('http').createServer((q,s)=>{s.writeHead(200);s.end('daemon-ok')}).listen({daemonPort},'127.0.0.1')"
```

```js eval
yield *
  when(
    function* () {
      yield* fetch(daemonUrl + "/health").expect();
    },
    { timeout: 5000, interval: 50 },
  );
```

The daemon is alive — the response below is the evidence that startup,
readiness polling, and the daemon's lifetime all worked:

<Capture as="daemonResponse">
```bash exec
curl -s http://127.0.0.1:{daemonPort}
```
</Capture>

{daemonResponse}

When this section ends, the daemon process is terminated by structured
concurrency — no manual cleanup needed.

<Test name="Daemons">
<AssertEquals actual={daemonResponse} expected={"\ndaemon-ok"} />
</Test>

</Section>
