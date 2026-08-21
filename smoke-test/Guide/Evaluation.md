<Section title="In-Process Evaluation">

Eval blocks run JavaScript **in-process** as Effection generator operations.
Unlike `exec` blocks (which run shell commands in a subprocess), `eval`
blocks execute in the same process, sharing a binding environment across
blocks within a component. Eval blocks produce **no rendered output** —
they exist for bindings and side effects. The `persist` modifier extends
a block's resource lifetime from the block scope to the component scope,
the `timeout` modifier cancels a block that overruns its duration, and bare
`{name}` references interpolate durable eval bindings into other code blocks.
`ephemeral eval` reconstructs invocation-local live bindings without output or
journal events.

</Section>

<Test name="Eval blocks render no output">
<Let as="evalRendered">
```js eval
const quietValue = 1;
```
</Let>
<AssertEquals actual={evalRendered} expected={""} />
</Test>

<Test name="Eval blocks share bindings">
```js eval
const greeting = "Hello from eval";
const numbers = [1, 2, 3];
```
```js eval
const message = `${greeting} with ${numbers.length} numbers`;
```
<AssertEquals actual={message} expected={"Hello from eval with 3 numbers"} />
</Test>

<Test name="Persist keeps spawned tasks alive across blocks">
```js persist eval
const status = { ready: false };
yield *
  spawn(function* () {
    yield* sleep(10);
    status.ready = true;
  });
```
```js eval
yield *
  when(function* () {
    if (!status.ready) throw new Error("not ready");
  });
const serverReady = status.ready;
```
<AssertStrictEquals actual={serverReady} expected={true} />
</Test>

<Test name="Timeout-bounded eval blocks complete">
```js timeout=30s eval
const startedAt = Date.now();
```
<AssertExists actual={startedAt} />
</Test>

<Test name="Eval bindings interpolate into exec blocks">
```js eval
const label = "configured";
```
<Let as="portEcho">
```bash exec
echo "Service is {label}"
```
</Let>
<AssertEquals actual={portEcho} expected={"\nService is configured"} />
</Test>

<Test name="Ephemeral eval reconstructs live bindings without rendering">
<Let as="ephemeralRendered">
```js ephemeral eval
const reconstructed = "live";
```
</Let>
<AssertEquals actual={ephemeralRendered} expected={""} />
</Test>
