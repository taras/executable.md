<Section title="Background Processes">

The `daemon` modifier starts a long-running process that survives across
subsequent blocks. Combined with `when()` for readiness polling, this
implements the provider pattern: start a service, wait until it's ready,
then run against it. The test below allocates a port, starts a Node HTTP
server as a daemon, polls until it responds, and asserts the response —
when the test's scope closes, structured concurrency terminates the
daemon with no manual cleanup.

</Section>

<Test name="A daemon serves requests until its scope closes">
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
<Capture as="daemonResponse">
```bash exec
curl -s http://127.0.0.1:{daemonPort}
```
</Capture>
<AssertEquals actual={daemonResponse} expected={"\ndaemon-ok"} />
</Test>
