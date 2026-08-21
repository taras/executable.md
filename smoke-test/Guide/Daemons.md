<Section title="Background Processes">

The `daemon` modifier starts an arbitrary long-running process with configuration
the document or host already owns. The test below starts a process that remains
alive while the next block runs. When the test's scope closes, structured
concurrency terminates the daemon with no manual cleanup. Attached services use
`service=<binding>` instead.

</Section>

<Test name="A daemon stays alive until its scope closes">
```bash daemon exec
node -e "setInterval(() => {}, 1000)"
```
<Let as="daemonResponse">
```bash exec
echo daemon-ok
```
</Let>
<AssertEquals actual={daemonResponse} expected={"\ndaemon-ok"} />
</Test>

<Test name="An attached service publishes a scoped live endpoint">
<AttachedServiceProvider>
<Let as="attachedServiceResponse">
<Sample prompt="use the service" />
</Let>
<AssertEquals
  actual={attachedServiceResponse}
  expected={"\n\nattached:127.0.0.1:true"}
/>
</AttachedServiceProvider>
</Test>
