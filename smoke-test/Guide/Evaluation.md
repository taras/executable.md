<Section title="In-Process Evaluation">

Eval blocks run JavaScript **in-process** as Effection generator operations.
Unlike `exec` blocks (which run shell commands in a subprocess), `eval`
blocks execute in the same process, sharing a binding environment across
blocks within a component. Eval blocks produce **no rendered output** —
they exist for bindings and side effects:

<Capture as="evalRendered">
```js eval
const greeting = "Hello from eval";
const numbers = [1, 2, 3];
```

The bindings from the previous block are available here:

```js eval
const message = `${greeting} with ${numbers.length} numbers`;
```
</Capture>

{evalRendered}

The `persist` modifier extends a block's resource lifetime from the
block scope to the component scope. Without `persist`, spawned tasks
and resources are torn down when the eval block completes. With it,
they survive for all subsequent blocks in the component.

The block below spawns a background task that sets `status.ready`
after a short delay. Because it uses `persist`, the task stays alive:

```js persist eval
const status = { ready: false };
yield *
  spawn(function* () {
    yield* sleep(10);
    status.ready = true;
  });
```

The next block converges on the spawned task using `when()`. This
only works because `persist` kept the task alive across the block
boundary — without it, the task would have been torn down:

```js eval
yield *
  when(function* () {
    if (!status.ready) throw new Error("not ready");
  });
const serverReady = status.ready;
```

The `timeout` modifier cancels the block if it does not complete within
the specified duration. Accepted units: `ms`, `s`, `m`.

```js timeout=30s eval
const startedAt = Date.now();
```

The `findFreePort` VM global finds an available TCP port using the OS:

```js eval
const port = yield * findFreePort();
```

Eval binding interpolation substitutes bare `{name}` references in code
block content with values from the eval binding environment. The port
allocated above flows into subsequent blocks via `{port}`:

<Capture as="portEcho">
```bash exec
echo "Server would start on port {port}"
```
</Capture>

{portEcho}

Eval and exec blocks coexist independently in the same document:

```bash exec
echo "Exec blocks are independent of eval bindings"
```

<Test name="Evaluation">
<AssertEquals actual={evalRendered} expected={"\n\nThe bindings from the previous block are available here:"} />
<AssertEquals actual={message} expected={"Hello from eval with 3 numbers"} />
<AssertStrictEquals actual={serverReady} expected={true} />
<AssertExists actual={startedAt} />
<AssertGreater actual={port} expected={0} />
<AssertEquals actual={portEcho} expected={"\nServer would start on port " + port} />
</Test>

</Section>
