# @effectionx/durable-streams

Durable execution for [Effection](https://frontside.com/effection) — crash-safe generator workflows that survive process restarts by journaling effects to an append-only stream.

```typescript
import { durableRun, durableCall, durableAll } from "@effectionx/durable-streams";

function* processOrder(orderId: string): Workflow<void> {
  const order = yield* durableCall("fetchOrder", () => fetchOrder(orderId));
  const [fraud, inventory] = yield* durableAll([
    () => durableCall("checkFraud", () => checkFraud(order)),
    () => durableCall("checkInventory", () => checkInventory(order)),
  ]);
  yield* durableCall("chargeCard", () => chargeCard(order.payment));
  yield* durableCall("fulfillOrder", () => fulfill(order));
}
```

If the process crashes between `chargeCard` and `fulfillOrder`, the workflow resumes exactly from that point. `chargeCard` is not called again. `fulfillOrder` runs once, as intended.

---

## Mental model

An Effection generator is already an **effect description machine** — it yields descriptions of what it wants to happen, and the runtime interprets them. `@effectionx/durable-streams` extends this: instead of simply executing each effect, the runtime first journals the result to an append-only stream, then resumes the generator.

On restart, the runtime reads those journal entries back and feeds the stored results directly into the generator, replaying its execution path without re-running any side effects. When the journal runs out, execution transitions seamlessly to live mode.

The generator itself never knows which mode it's in. It sees a sequence of values flowing from `yield*` — whether those values came from a live network call or a replay of one is invisible to it.

This means your workflow logic is written once, with no replay-awareness code, no `if (replaying)` branches, and no explicit checkpoint calls.

---

## The journal: what goes in, what doesn't

The journal is an append-only stream of two event types:

```typescript
type DurableEvent = Yield | Close;
```

**`Yield`** is written after a user-facing effect resolves. It records both the effect description (what was requested) and the result (what happened):

```typescript
interface Yield {
  type: "yield";
  coroutineId: string; // e.g. "root.0.1"
  description: {
    type: string; // "call", "sleep", "action", etc.
    name: string; // the stable effect name
    [key: string]: Json; // extra input fields, stored verbatim
  };
  result: Result; // { status: "ok", value } | { status: "err" } | { status: "cancelled" }
}
```

**`Close`** is written when a coroutine terminates — whether it completed, threw an error, or was cancelled — after its retained subtree is aligned. Alignment requires every retained yield to be consumed and every retained child coroutine to be claimed by the current definition. Close events are load-bearing: they tell the runtime on restart which coroutines finished cleanly and which need re-execution. An unaligned termination is divergence and appends no `Close`.

### What goes into the journal

User-facing effects: anything that interacts with the outside world. In practice, anything you express with `durableCall`, `durableSleep`, `durableAction`, `durableEach`, or a custom `createDurableEffect`.

```text
[0] yield  root    { type: "call",  name: "fetchOrder" }    result: { status: "ok", value: { id: "42", ... } }
[1] yield  root.0  { type: "call",  name: "checkFraud" }    result: { status: "ok", value: true }
[2] yield  root.1  { type: "call",  name: "checkInventory" } result: { status: "ok", value: true }
[3] close  root.0  result: { status: "ok", value: true }
[4] close  root.1  result: { status: "ok", value: true }
[5] yield  root    { type: "call",  name: "chargeCard" }     result: { status: "ok" }
[6] yield  root    { type: "call",  name: "fulfillOrder" }   result: { status: "ok" }
[7] close  root    result: { status: "ok" }
```

### What doesn't go into the journal

**Infrastructure effects** — scope setup, context reads, middleware. These run transparently during both live execution and replay. They're deterministic by construction: they depend only on the runtime's internal state, which is reconstructed identically during replay because all user-facing effects are replayed in order.

The `ephemeral()` function is the explicit escape hatch when you need to run non-durable Effection operations inside a `Workflow`. It produces no journal entry and re-runs on replay:

```typescript
function* myWorkflow(): Workflow<string> {
  // useScope() is infrastructure — use ephemeral() to run it in a Workflow
  const signal = yield* ephemeral(useAbortSignal());

  // durableCall is journaled
  return yield* durableCall("fetchData", () => fetchData(signal));
}
```

---

## Workflows vs. Operations

A `Workflow<T>` is a generator that only yields `DurableEffect` values. TypeScript enforces this at compile time — yielding a plain Effection `Operation` inside a `Workflow` generator is a type error:

```typescript
function* safeWorkflow(): Workflow<void> {
  yield* durableSleep(1000); // ✓ DurableEffect
  yield* durableCall("fetch", fn); // ✓ DurableEffect
  yield* sleep(1000); // ✗ TypeError — use durableSleep
  yield* call(fn); // ✗ TypeError — use durableCall
}
```

This is the key design guarantee: **if it compiles as a `Workflow`, it's durable** (except values explicitly wrapped with `ephemeral()`, which intentionally opt out of journaling).

Every `Workflow<T>` is structurally compatible with `Operation<T>`, so you can always use a workflow where an operation is expected.

### Core workflow effects

| Effect                                           | Description                                          |
| ------------------------------------------------ | ---------------------------------------------------- |
| `durableCall(name, fn)`                          | Call a function returning a `Promise` or `Operation` |
| `durableSleep(ms)`                               | Wait for a duration                                  |
| `durableAction(name, executor)`                  | Custom callback-based effect                         |
| `versionCheck(name, { minVersion, maxVersion })` | Version gate for code evolution                      |
| `durableEach(name, source)`                      | Durable iteration with per-item checkpointing        |

### Concurrency combinators

Combinators return `Workflow<T>` and delegate to Effection's native structured concurrency primitives. Children must themselves be `Workflow<T>`.

| Combinator                    | Behavior                                       |
| ----------------------------- | ---------------------------------------------- |
| `durableSpawn(workflow)`      | Spawn a concurrent child, returns `Task<T>`    |
| `durableAll([...workflows])`  | Run all concurrently, wait for all to complete |
| `durableRace([...workflows])` | Run all, return first winner, cancel the rest  |

### Prefer Operations over async/await

When writing functions called from `durableCall`, prefer returning an `Operation` over a `Promise`. Operations participate fully in Effection's structured concurrency — they can be cancelled, they respect scope lifetimes, and they compose cleanly:

```typescript
// Prefer this:
function fetchUser(id: string): Operation<User> {
  return resource(function* (provide) {
    const controller = new AbortController();
    try {
      const response = yield* call(() => fetch(`/users/${id}`, { signal: controller.signal }));
      yield* provide(yield* call(() => response.json()));
    } finally {
      controller.abort();
    }
  });
}

// Over this:
async function fetchUser(id: string): Promise<User> {
  const response = await fetch(`/users/${id}`);
  return response.json();
}

// Both work with durableCall, but the Operation version is cancellable:
const user = yield * durableCall("fetchUser", () => fetchUser(id));
```

When the parent scope is cancelled (e.g., a race loser), an `Operation`-returning function cleans up immediately. A `Promise`-returning function keeps the network request open until it settles.

### Durable iteration

Use `durableEach` to iterate over a source with per-item checkpointing. Each call to `durableEach.next()` produces a journal entry — if the process crashes mid-loop, it resumes at the next unprocessed item:

```typescript
function* processQueue(): Workflow<void> {
  for (let msg of yield* durableEach("queue", queueSource)) {
    yield* durableCall("process", () => processMessage(msg));
    yield* durableEach.next(); // checkpoint + pre-fetch next item
  }
}
```

The `DurableSource` interface uses Operations:

```typescript
interface DurableSource<T extends Json> {
  next(): Operation<{ value: T } | { done: true }>;
  close?(): void; // called on cancellation or completion, must be idempotent
}
```

---

## Entry point: durableRun

`durableRun` is itself an `Operation<T>` — it inherits the caller's Effection scope, including any middleware installed on it:

```typescript
function* durableRun<T extends Json | void>(
  workflow: () => Workflow<T> | Operation<T>,
  options: { stream: DurableStream; coroutineId?: string }
): Operation<T>
```

Typical usage from standalone async code:

```typescript
import { run } from "effection";
import { durableRun } from "@effectionx/durable-streams";
import { useHttpDurableStream } from "@effectionx/durable-streams";

await run(function* () {
  const stream = yield* useHttpDurableStream({
    baseUrl: "http://localhost:4437",
    streamId: "order-42",
    producerId: "worker-1",
    epoch: 1,
  });

  const result = yield* durableRun(() => processOrder("order-42"), { stream });
});
```

When `durableRun` is called as a generator inside another generator, it shares the parent's scope chain. Middleware installed before the `yield*` is visible inside the workflow.

---

## Runtime APIs

Effects that interact with the operating system (file I/O, subprocess
execution, HTTP requests) use runtime operations from `@executablemd/runtime`
instead of importing platform APIs directly.

For normal calls, durable effects use exported operations (`exec`,
`readTextFile`, `glob`, `fetch`, `env`, `platform`). To customize behavior, use
`API.*.around()` middleware on the current scope:

```typescript
import { API } from "@executablemd/runtime";

function* main(): Operation<void> {
  yield* API.Process.around({
    *exec([options], next) {
      // custom behavior before/after exec
      return yield* next(options);
    },
  });

  yield* durableRun(() => myWorkflow(), { stream });
}
```

The API surface is Operation-native — including Env handlers (`env`,
`platform`) — so cancellation and teardown continue to flow through Effection
scope ownership. Test helpers for common runtime stubs are provided by
`@executablemd/runtime/test`.

---

## Coroutine identity

Every generator instance running under `durableRun` gets a stable coroutine ID — a dot-delimited path that encodes its position in the scope tree:

```text
root                    → "root"
  first child of root   → "root.0"
  second child of root  → "root.1"
    first child of .1   → "root.1.0"
```

These IDs are assigned by a per-parent creation counter and are identical across runs, given the same generator code and the same resolution sequence. This determinism is what makes it possible to match journal entries to the right generator instances on replay.

You never assign or manage coroutine IDs manually — they're derived entirely from the structure of your generator code.

---

## Replay

When `durableRun` starts, it reads the full event stream, builds an in-memory `ReplayIndex`, then starts the workflow generator. As the generator yields effects:

1. **Replay path** — if the index has an entry for this coroutine at this position, the stored result is fed directly to the generator via `iterator.next(value)` or `iterator.throw(error)`. The effect's live executor is never called.

2. **Live path** — if the index has no entry, the effect executes normally. Once it resolves, the result is persisted to the stream _before_ the generator is resumed (`persist-before-resume`).

The transition from replay to live happens **per-coroutine**, not globally. In a fork/join workflow where two children ran before a crash and a third didn't, the first two replay their stored results while the third executes live — all simultaneously, within the same `durableAll`.

### Persist-before-resume

This is the protocol's most critical invariant: **the `Yield` event must be durably written to the stream before `iterator.next()` is called**. If the process crashes between an effect resolving and the journal write completing, the effect will be re-executed on the next run — which is safe, because the generator hasn't advanced past that point yet.

If the backing-stream write fails, the run raises `DurablePersistenceError`
with the adapter error as its cause. It does not resume the effect successfully
or write a compensating `Close(err)`. The same rule applies when a terminal
`Close` cannot be persisted. A `guardDurableStream` gate rejection remains the
gate's ordinary failure and may produce a separately admitted `Close(err)`.

Violating this invariant (advancing the generator before the write) creates an unrecoverable gap: the journal would be missing an entry, and replay would feed the wrong result to a subsequent effect.

### Live operation coordinators

`createDurableOperation` accepts an optional
`LiveDurableOperationCoordinator`. The default coordinator executes the live
operation once, converts its success or failure to the existing protocol
`Result`, invokes the Yield publication continuation once, and returns that
same result after publication completes. Replay bypasses the coordinator,
executor, continuation, and live append; a partially replayed run coordinates
only its live suffix.

The coordinator receives non-operational journal provenance and an
infrastructure-failure activator. See
[Journal provenance](#journal-provenance) for what that witness proves and how
it travels.

A provider
whose execution and publication share a larger durability boundary calls it
when that boundary cannot commit. It returns the first active failure by
identity, so the provider throws that exact failure and later durable work stays
fenced. The default coordinator does not call this continuation: an ordinary
execution failure remains the existing failed protocol `Result`.

The publication continuation uses the ordered append fence described above. A
backing append failure therefore activates the same fail-stop state and raises
`DurablePersistenceError` with the adapter error as its cause. A marked
pre-persistence policy rejection remains an ordinary policy failure. There is no
generic validation option on durable operations: a caller or provider validates
before constructing the durable effect. Callback-based durable effects retain
their existing execution path.

---

## Divergence detection

During replay, every yielded effect is validated against its journal entry. Only two fields are compared: `description.type` and `description.name`. If they match, replay proceeds. If they don't, a `DivergenceError` is raised immediately.

```typescript
// Journal has: { type: "call", name: "fetchOrder" }
// Code yields:  { type: "call", name: "chargeCard" }  ← mismatch at position 0
// → DivergenceError
```

Three additional terminal conditions are checked:

- **Generator finishes early**: the code returns before consuming all journal entries — effects were removed.
- **Generator fails early**: the code throws before consuming all journal entries — the ordinary failure cannot close over retained effects the current execution never reached.
- **Generator continues past close**: the journal shows the coroutine closed, but the code keeps yielding — effects were added.
- **Completed child is abandoned**: retained child history has a `Close`, but the current definition never claims that coroutine identity.

All indicate the code has changed in a way that makes the stored history invalid. Early return raises `EarlyReturnDivergenceError`; early failure raises `TerminalDivergenceError` with the ordinary failure as its cause. Neither appends a terminal `Close`, so a compatible definition can still replay the retained history. The solution for intentional code changes is `versionCheck`:

```typescript
function* orderWorkflow(orderId: string): Workflow<void> {
  const version = yield* versionCheck("add-fraud-check", { minVersion: 0, maxVersion: 1 });

  if (version >= 1) {
    // New in v1 — in-flight v0 workflows skip this, new v1 workflows run it
    yield* durableCall("fraudCheck", () => fraudCheck(orderId));
  }

  yield* durableCall("fetchOrder", () => fetchOrder(orderId));
  yield* durableCall("chargeCard", () => chargeCard(orderId));
}
```

### Divergence policy

The default divergence policy is strict — any mismatch is fatal. You can override this per-scope using `scope.around(Divergence, ...)`:

```typescript
scope.around(Divergence, {
  decide([info], next) {
    // "run-live" disables replay from this point forward for this coroutine
    if (info.kind === "description-mismatch" && canRecoverFrom(info)) {
      return { type: "run-live" };
    }
    return next(info);
  },
});
```

The `run-live` decision tells the runtime to disable replay for that coroutine and execute all subsequent effects live, effectively treating the crash point as the beginning of a fresh run.

---

## Replay guards

Divergence detection catches _structural_ mismatches — the effect sequence changed. Replay guards catch _staleness_ mismatches — the effect sequence is the same, but the external world has changed since the journal entry was recorded.

The canonical example is a file-backed effect. If the workflow previously read `./component.mdx` and that file has since been edited, replaying the stored result would silently use stale content. A replay guard detects this and can halt replay with an error.

### The three stages

A replay guard has three stages, separated by a strict I/O boundary:

**Stage 1 — `check`**: runs in generator context before replay begins, once per retained `Yield`. I/O is allowed. Use it to gather current state (compute file hashes, check timestamps) and cache results in the middleware closure.

**Stage 2 — `admit`**: runs once after every retained event has been offered to `check`, and before a recorded terminal result is reused. It receives the retained history as a whole — the coroutine about to be resumed, its retained `Yield`s, and whether a terminal result exists for it. A guard that requires something of the history *as a whole* — that an event it validates is present at all, and present once — refuses here, because a per-event `check` has nothing to object to in a journal that simply omits the event. The default is a no-op.

**Stage 3 — `decide`**: runs synchronously inside the replay loop, after identity matching succeeds. Must be pure — no I/O, no side effects. Reads from the cache populated during `check` and returns a `ReplayOutcome`.

The separation between generator and synchronous stages is necessary because the replay loop is synchronous. All observation-gathering must happen upfront.

### Three views of one history

A replay distinguishes three things, and conflating any two of them hands authority to whoever holds the wrong one:

1. **The authoritative retained history.** What a consumer's own admission validated and what replay consumes. Detached from the backend and immutable to policy — its descriptions and results are frozen through, so nothing that receives it can rewrite what replay will decide.
2. **Isolated guard observations.** What `check`, `admit`, and `decide` receive: a deep, mutable copy made per invocation. Middleware may read, annotate, and compose over it freely; nothing it writes reaches replay.
3. **Values delivered to workflow code.** A fresh mutable copy taken from the authority at the moment of consumption — for a replayed effect and for a completed run's own return value alike. This is the only thing "mutable replayed value" ever means: a document that resumes on a restored binding writes to its copy, and writing to it cannot reach the authority or the next replay.

The authority is frozen through in **every** settlement shape — a success with a value, a `Result<void>` with none, a failure, and a cancellation, on `Yield` and `Close` alike. An envelope left writable is one a public observation could add a value to before replay reads it.

Handing policy the authoritative events would let a guard rename effect A to B — so a workflow asking for B consumes A's result without B ever running — or rewrite a recorded root selection after admission accepted it.

### Guards are policy, not authority

A replay guard is **composable policy**. Guards compose through `Api.around`, and a handler installed further out may decline to call `next` — declining is what composition is for, and it means any single guard's opinion can be suppressed by another.

That makes a guard the wrong place for anything that decides *identity*. A consumer whose durable identity must hold regardless of what a document, a component, or an enclosing scope installs owns that check itself — for example by wrapping the `DurableStream` it hands to `durableRun`, so the validation happens inside the read every later phase depends on, reachable through no context and replaceable by nothing. `@executablemd/core` does exactly that for a document's selected target.

Use guards for staleness policy. Do not use them to enforce an invariant that must not be negotiable.

### Retained events are read once

Every phase of a replay reads the same events, and a journal is data a backend supplies. Events are therefore **retained**: read once and detached from whatever the backend still owns.

**Every** event that participates in admission, indexing, or terminal reuse is retained — `Close` as well as `Yield`. A `Close` decides whether a coroutine has a terminal result to reuse, so leaving it as the backend's own object lets it belong to a child coroutine while one phase asks and to the root while the next does.

The **discriminator** is settled by the classification that chooses an event's retained kind, and never read from the source again. **Identity** — the coroutine an event belongs to, and a `Yield`'s complete effect description — is settled once too, so no phase can be shown a different event than the phase before it. An event that refuses to say what it is is refused from every member.

A `Yield`'s **settlement** stays lazy and separate, because the index is built before guards run and a guard that would refuse an event must get that chance before the stream is asked to produce a result.

A `Close`'s result is settled **while the history is retained**, not at a first later read. A `Close` carries what a completed run hands back, and deferring that read leaves an interval — between the moment a consumer's own admission accepts the history and the moment terminal reuse consumes it — in which the backend still owns the answer and can replace it. Reading once at a later getter closes repeated reads and leaves that window open.

Every cell keeps both outcomes: a refusal is remembered and re-raised rather than retried, so retaining a history never fails and a refusal reaches whichever phase asks.

A retained event presents its members as ordinary own properties, so it spreads, serializes, and compares like the plain event a backend would have supplied.

A detached result shares no object or array with the journal, and remains ordinary mutable JSON — detaching is a claim against the *stream*, not against the consumer, and replayed values are legitimately written to.

### Writing a replay guard

Use `scope.around(ReplayGuard, ...)` to install a guard. The guard receives each `Yield` event from the journal:

```typescript
import { ReplayGuard, type ReplayOutcome } from "@effectionx/durable-streams";
import { call, useScope } from "effection";
import type { Operation } from "effection";

function* useMyGuard(): Operation<void> {
  const scope = yield* useScope();

  // The cache lives in this closure — populated during check, read during decide
  const cache = new Map<string, string>();

  scope.around(ReplayGuard, {
    // Phase 1: gather observations (I/O allowed, runs before replay starts)
    *check([event], next): Operation<void> {
      const resourceId = event.description.resourceId;
      if (typeof resourceId === "string" && !cache.has(resourceId)) {
        const currentVersion = yield* call(() => fetchCurrentVersion(resourceId));
        cache.set(resourceId, currentVersion);
      }
      return yield* next(event); // always call next — other guards may need this event
    },

    // Phase 2: make a decision (synchronous, pure, no I/O)
    decide([event], next): ReplayOutcome {
      const resourceId = event.description.resourceId;
      if (typeof resourceId !== "string") {
        return next(event); // not our event — delegate
      }

      const storedVersion = (event.result as any)?.value?.version;
      const currentVersion = cache.get(resourceId);

      if (currentVersion && currentVersion !== storedVersion) {
        return {
          outcome: "error",
          error: new Error(
            `Resource changed: ${resourceId} (stored: ${storedVersion}, current: ${currentVersion})`,
          ),
        };
      }

      return next(event); // no opinion — delegate
    },
  });
}
```

Install the guard before calling `durableRun`:

```typescript
function* supervisedWorkflow(): Operation<void> {
  yield* useMyGuard(); // children inherit this through Effection's scope inheritance

  yield* durableRun(() => myWorkflow(), { stream });
}
```

### Effect descriptions carry input data; results carry output data

For a guard to work, the effect being guarded must store the information needed for validation:

- **Input fields** (the path, resource ID, URL) go in extra fields on `EffectDescription`. These fields are stored verbatim in the journal but never compared during divergence detection.
- **Output fields** (content hash, ETag, version) go in `result.value` alongside the actual content.

```typescript
import { readFile } from "node:fs/promises";

function* durableReadFile(path: string): Workflow<string> {
  const { content } = yield* durableCall("readFile", async () => {
    const content = await readFile(path, "utf8");
    const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
    const contentHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    return { content, contentHash };
    //  ↑ content hash returned alongside the actual content
  });
  return content;
}

// The description stored in the journal:
// { type: "call", name: "readFile", path: "./input.txt" }
//                                   ↑ path stored as extra field

// The result stored in the journal:
// { status: "ok", value: { content: "...", contentHash: "sha256:abc123" } }
//                                           ↑ hash stored in result value
```

The guard's `check` phase reads `event.description.path` and computes the current hash. The `decide` phase reads `event.result.value.contentHash` and compares. No separate metadata or side-channel is needed.

### Guard composition

Multiple guards compose naturally. Each guard either returns an outcome or calls `next(event)` to pass control to the next guard in the chain:

```typescript
function* supervisedPipeline(): Operation<void> {
  yield* useResourceVersionGuard();
  yield* useMyCustomGuard();

  yield* durableRun(() => pipeline(), { stream });
}
```

If any guard returns `{ outcome: "error" }`, replay halts. Guards that return `next(event)` delegate, and the default at the bottom of the chain always returns `{ outcome: "replay" }` — preserving "logs are authoritative" for events that no guard has an opinion on.

---

## Stream backends

`DurableStream` is an abstract interface:

```typescript
interface DurableStream {
  readAll(): Operation<DurableEvent[]>;
  append(event: DurableEvent): Operation<void>;
}
```

### In-memory (testing)

```typescript
import { InMemoryStream } from "@effectionx/durable-streams";

const stream = new InMemoryStream();
// Or pre-populate with events:
const prepopulatedStream = new InMemoryStream(existingEvents);
// Inspect append count, inject failures:
stream.appendCount;
stream.injectFailure = new Error("disk full");
```

### HTTP (Durable Streams protocol)

Backed by the [Durable Streams](https://durable.run) protocol — an append-only HTTP streaming protocol with idempotent producers and epoch-based fencing.

```typescript
import { useHttpDurableStream } from "@effectionx/durable-streams";

const stream =
  yield *
  useHttpDurableStream({
    baseUrl: "http://localhost:4437",
    streamId: "workflow-abc-123",
    producerId: "scheduler-worker-1",
    epoch: 1, // increment this on scheduler restart to fence zombie writers
  });
```

Appends are serialized via an internal queue and worker — concurrent `append()` calls from `durableAll` children are safely sequenced without application-level coordination. Every append is synchronous (no `lingerMs` batching) to preserve `persist-before-resume`.

### Custom backends

Implement `DurableStream` directly. The only requirements are append-only semantics, prefix-closure (no gaps), and that `append()` only resolves after the event is durably persisted:

```typescript
class PostgresStream implements DurableStream {
  *readAll(): Operation<DurableEvent[]> {
    return yield* call(() =>
      db
        .query("SELECT event FROM events WHERE stream_id = $1 ORDER BY position", [this.streamId])
        .then((r) => r.rows.map((r) => r.event)),
    );
  }

  *append(event: DurableEvent): Operation<void> {
    yield* call(() =>
      db.query("INSERT INTO events (stream_id, event) VALUES ($1, $2)", [this.streamId, event]),
    );
  }
}
```

### Serializing an event

`serializeDurableEvent` is the shared NDJSON record — the one file persistence
writes and the one anything inspecting the persisted form reads. It is ordinary
`JSON.stringify(event) + "\n"`: one line, terminating newline included, fields in
the event object's own insertion order. Nothing is sorted, normalized, or
otherwise canonicalized; sharing the function is what keeps writer and reader
from drifting apart, not any canonical form of the output.

```typescript
import { serializeDurableEvent } from "@effectionx/durable-streams";

const record = serializeDurableEvent(event); // '{"type":"yield",…}\n'
```

It fails when `JSON.stringify` throws — a circular structure or a `BigInt` — or
when it does not return a string. Values `JSON.stringify` silently coerces or
drops are left alone: `undefined`, function and symbol members are omitted, and
non-finite numbers become `null`.

Structured backends keep their own transport encoding. This function defines the
representation used by file persistence and by anything that inspects the
persisted form.

### Reading an event back

`parseDurableEvent` is the inverse. A backend that retains the record rather
than the event — a journal file, a SQLite column — reads it back through this
function. The terminating newline is optional, so a stored record and a line
split out of a journal file both parse.

```typescript
import { parseDurableEvent } from "@effectionx/durable-streams";

const result = parseDurableEvent(record);
if (!result.ok) {
  // result.error is a MalformedDurableEventError; `.path` names the member,
  // such as `$.result.error.message`.
}
```

The record is parsed, never trusted. Every member is checked against the
protocol types and the event is rebuilt from the checked members. The closed
shapes — the event envelope, a `Result`, a `SerializedError` — reject members
they do not declare, while an `EffectDescription` admits the extra `Json`
members replay guards read.

Nothing from the record reaches the failure. Members the protocol does not name
appear in the path as `*` rather than by name, because a record's own member
names are as much retained content as its values, so a parse failure copies
neither into logs and terminals.

---

## Pre-persistence gates

`guardDurableStream` wraps a stream so a host-supplied check runs before each
live event reaches its backend:

```typescript
import { guardDurableStream } from "@effectionx/durable-streams";

const guarded = guardDurableStream(stream, function* (event) {
  if (yield* containsCredential(event)) {
    throw new Error("refusing to journal a credential");
  }
});
```

The gate returns nothing and receives a *copy* of the event, so it can inspect or
reject but never rewrite: whatever it does to the object it was handed, the
backend still receives the event the effect produced. And the backend append is a
statement after the gate rather than a continuation handed to it — so there is
nothing a gate can invoke twice, and one durable yield still produces at most one
journal event.

What counts as grounds for rejection is the host's policy. This package supplies
the boundary, not the rules.

- **Success** — the original event goes to the underlying stream exactly once.
  `append()` resolves only after both the gate and the backend succeed, so
  persist-before-resume is unchanged.
- **Failure or cancellation** — the backend is never invoked, and the failure
  propagates to the durable effect that produced the event.
- **Replay** — `readAll()` delegates straight through, so restoring a journal
  never re-runs the gate.

Wrap the stream before execution begins to cover the complete live journal: the
root component import, every yield, every child close, and the root close.

### Rejection is per event

A gate rejects the event it was given, not the run. That event never reaches the
backend, but the resulting failure may lead the workflow to append a later
`Close` event with an `err` result — and that close crosses the gate on its own
and may be admitted.

A rejected append therefore does not imply an empty backend. Assert the absence
of the offending event, not that nothing was written.

### Journal provenance

A provider that owns a journal needs to know that the stream a run is
publishing into is still *its* journal, and not an in-memory stream, another
run's journal, or a look-alike wrapper. `establishJournalProvenance` answers
that question:

```typescript
import {
  establishJournalProvenance,
  guardDurableStream,
  preserveJournalProvenance,
} from "@executablemd/durable-streams";

const provenance = establishJournalProvenance(journal); // retained by the provider
```

The value is a `JournalProvenance` — a non-operational, equality-only witness.
It carries no append or read capability, and it means something only because
the provider retains it and later compares it by exact equality with the
witness a live coordinator reports for the stream in use.

Establishment mints one fresh witness for one exact stream, and refuses to
replace an existing one. The association lives in this module's private weak
state, so a copied property, a stream that merely delegates, and a separately
loaded copy of this package can neither read nor forge it.

`guardDurableStream` is policy-neutral, and the wrapper it returns is unproven.
A wrapping site the provider trusts — XMD's secret filter is the one in this
repository — preserves provenance explicitly:

```typescript
const guarded = guardDurableStream(journal, gate);
return preserveJournalProvenance(journal, guarded);
```

`preserveJournalProvenance` returns the exact target it was handed, and
transfers only the witness already associated with the exact source: an
unproven source leaves the target unproven, and nesting trusted wrappers
carries the same witness through each one.

A wrapping site is trusted when it is installed before any code the journal's
own content could influence, and delegates to the exact stream it was handed.
`@executablemd/core` has two, and a document execution's journal passes through
both: the secret filter, and the execution-owned wrapper that admits a run's
recorded target before replay. Each transfers only what its source already had,
so an unproven journal stays unproven through both.

---

## Long-running workflows

For workflows that process unbounded streams, journals grow without limit. The `durableEach` + Continue-As-New pattern bounds this growth: after N iterations, the workflow signals for a fresh start with the current cursor position as its seed. This is a planned feature — in the meantime, `durableEach` is appropriate for bounded batches where journal size is not a constraint.

---
