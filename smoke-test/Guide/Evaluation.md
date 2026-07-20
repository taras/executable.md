<Capture as="rendered">

<Section title="In-Process Evaluation">

Eval blocks run JavaScript **in-process** as Effection generator operations.
Unlike `exec` blocks (which run shell commands in a subprocess), `eval`
blocks execute in the same process, sharing a binding environment across
blocks within a component.

Bindings declared in one eval block are available in subsequent blocks:

```js eval
const greeting = "Hello from eval";
const numbers = [1, 2, 3];
```

The bindings from the previous block are available here:

```js eval
const message = `${greeting} with ${numbers.length} numbers`;
```

Eval blocks produce **no rendered output** — they exist for bindings
and side effects. The output from eval blocks is empty, so nothing
appears between this text and the next section.

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
the specified duration. Accepted units: `ms`, `s`, `m`. If the block
times out, an error is recorded in the output and execution halts.

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

```bash exec
echo "Server would start on port {port}"
```

Eval and exec blocks coexist independently in the same document:

```bash exec
echo "Exec blocks are independent of eval bindings"
```

</Section>

</Capture>

{rendered}

<Test name="Evaluation">
<AssertStringIncludes actual={rendered} expected={"\u00a7 In-Process Evaluation"} />
<AssertNotMatch actual={rendered} expected={/Hello from eval/} />
<AssertNotMatch actual={rendered} expected={/with 3 numbers/} />
<AssertNotMatch actual={rendered} expected={/serverReady/} />
<AssertNotMatch actual={rendered} expected={/startedAt/} />
<AssertStringIncludes actual={rendered} expected={"kept the task alive"} />
<AssertMatch actual={rendered} expected={/Server would start on port \d+/} />
<AssertStringIncludes actual={rendered} expected={"Exec blocks are independent of eval bindings"} />
</Test>
