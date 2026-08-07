<Section title="Background Processes">

The `daemon` modifier starts an arbitrary long-running process with configuration
the document or host already owns. The test below starts a process that remains
alive while the next block runs. When the test's scope closes, structured
concurrency terminates the daemon with no manual cleanup. Cooperative dynamic
services use `service=<binding>` instead.

</Section>

<Test name="A daemon stays alive until its scope closes">
```bash daemon exec
node -e "setInterval(() => {}, 1000)"
```
<Capture as="daemonResponse">
```bash exec
echo daemon-ok
```
</Capture>
<AssertEquals actual={daemonResponse} expected={"\ndaemon-ok"} />
</Test>

<Test name="A cooperative service publishes a scoped live endpoint">
<CooperativeProvider>
<Capture as="cooperativeResponse">
<Sample prompt="use the service" />
</Capture>
<AssertEquals
  actual={cooperativeResponse}
  expected={"\n\ncooperative:127.0.0.1:true"}
/>
</CooperativeProvider>
</Test>
