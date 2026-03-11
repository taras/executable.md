# EMA Daemon Modifier Specification

**Status:** Draft
**Audience:** Implementing agent
**Inputs:** `executable-mdx-spec.md` (§3–4, §8),
`@effectionx/scope-eval`, `@effectionx/process` (`daemon`), `@effectionx/converge` (`when`)

---

## 1. Overview

This document specifies three additions to the EMA execution model that together
enable background process management expressed entirely within document markup —
no framework-level configuration, no `RunDocumentOptions` changes:

1. **Eval binding interpolation** — bare `{name}` references in code block content
   resolve from the current eval binding environment (`env.values`), allowing values
   produced by `eval` blocks to flow into subsequent `exec` and `daemon` block arguments.

2. **`daemon` modifier** — a new terminal modifier that forks a long-running
   subprocess into the component's eval scope. The process is alive for the duration
   of component expansion and killed when the component scope closes. Unlike `exec`,
   it produces no journal entry and never waits for the process to exit.

3. **Provider component pattern** — the canonical composition of `eval` +
   `daemon` + `eval` (for readiness) + `<children />` into a reusable markdown
   component that manages background process lifecycle for its subtree.

These additions integrate entirely with the existing modifier middleware system
(§3.3), eval scope (§4.4), and binding environment (§4.3). No changes to
`RunDocumentOptions`, `runDocument`, or the journal protocol are required.

---

## 2. Eval binding interpolation

### 2.1 Motivation

A `daemon` block must receive the port number allocated by a preceding `eval`
block. The existing interpolation system (`{meta.key}`, `{props.key}`) covers
frontmatter and caller-supplied props, but not values produced at evaluation
time. A third interpolation source — the eval binding environment — fills this
gap.

### 2.2 Bare binding references

Inside any executable code block's **content**, bare `{name}` references (no
namespace prefix) resolve against `env.values`:

````markdown
```ts eval
const port = yield* findFreePort();
```

```bash daemon exec
./server --port {port}
```
````

`{port}` resolves to the number exported by the first block. The substituted
content is used to build the subprocess command.

### 2.3 Interpolation order and precedence

Content interpolation runs in this order before the modifier chain executes:

1. **Eval bindings** — bare `{name}` against `env.values`
2. **Meta values** — `{meta.key}` against the component's frontmatter
3. **Props** — `{props.key}` against validated caller props

Bare references only match against `env.values`. They do not fall through to
meta or props. If `env.values` has no key `name`, the reference `{name}` is
left verbatim. This avoids ambiguity between local bindings and frontmatter.

The regex for eval binding substitution matches JavaScript identifier syntax:

```
\{([a-zA-Z_$][a-zA-Z0-9_$]*)\}
```

Namespaced references (`{meta.*}`, `{props.*}`) are excluded — they contain a
`.` and are handled by the existing interpolation pass.

### 2.4 Where interpolation runs

Eval binding interpolation runs **once in the expansion engine**, in
`expandSegments`, immediately before `composeModifierChain` is called for a
`codeBlock` segment. By the time any modifier factory receives `ctx.content`,
the content is already fully interpolated — modifiers are not responsible for
text preparation and do not need to know interpolation exists.

This is consistent with how `{meta.key}` and `{props.key}` interpolation is
handled for `text` segments: the expansion engine owns the transition from raw
parsed content to executable input, applying all text preparation in one place
before handing off to the modifier chain.

```typescript
// In expandSegments, codeBlock case:
case "codeBlock": {
  const env = yield* ephemeral(EvalEnvCtx.expect());
  const interpolatedContent = interpolateEvalBindings(
    segment.content,
    env.values,
  );
  const context: CodeBlockContext = {
    language: segment.language,
    content: interpolatedContent,  // already interpolated before chain runs
    blockId: ...,
    componentName: ...,
  };
  const chain = composeModifierChain(segment.modifiers, context, registry);
  const result = yield* chain();
  // ...
}
```

The interpolation utility itself is a pure function with no Effection dependency:

```typescript
function interpolateEvalBindings(
  content: string,
  bindings: Record<string, unknown>,
): string {
  return content.replace(
    /\{([a-zA-Z_$][a-zA-Z0-9_$]*)\}/g,
    (match, key) => key in bindings ? String(bindings[key]) : match,
  );
}
```

This is a runtime operation — deterministic from `env.values` and the block
source. It produces no journal entry. On replay, `env.values` is populated from
the stored `durableEval` result (§4.5 of the main spec) before any subsequent
blocks execute, so interpolation produces the same substitutions as the original
run.

### 2.5 Serialization constraint

Only JSON-serializable values in `env.values` are stored in the journal (§4.1
of the main spec). Non-serializable values (functions, class instances) remain
in `env.values` as live references during the current run but are absent on
replay. For eval binding interpolation purposes this is acceptable: values used
in `{name}` substitutions are almost always primitives (port numbers, URLs,
strings) which are JSON-serializable and round-trip correctly through the
journal.

---

## 3. The `daemon` modifier

### 3.1 Purpose and contrast with `exec`

`exec` (via `durableExec`) runs a subprocess, waits for it to exit, and
journals the result. It models a **command with a result**.

`daemon` spawns a subprocess and immediately returns control to the document.
The process is expected to run indefinitely. It models a **resource with a
lifetime**. The two are not interchangeable:

| Property | `exec` | `daemon` |
|---|---|---|
| Waits for exit | Yes | No |
| Journal entry | Yes — stdout/stderr/exitCode | No |
| Crash detection | Via non-zero exit code in result | Via `daemon()` from `@effectionx/process` throwing |
| Lifetime | Until command exits | Until component scope closes |
| Replay behavior | Returns stored result, no subprocess | Spawns fresh subprocess every run |

### 3.2 Detection rule

`daemon` is a **terminal modifier** — it ignores `next()` and does not call the
inner chain. Because the executability detection rule (§3.2 of the main spec)
requires `exec` or `eval` as a word in the info string, `daemon` blocks are
written with `exec` present:

````markdown
```bash daemon exec
./server --port {port} --nobrowser
```
````

The `exec` modifier appears in the chain but is never invoked — `daemon` is
outermost and ignores `next`. The presence of `exec` in the info string is
purely syntactic: it satisfies the detection rule and signals to readers that
this block runs a command.

This parallels how `silent exec` uses `exec` for the terminal behavior while
`silent` intercepts the result. Here `daemon` intercepts at the lifecycle level
rather than the result level.

### 3.3 Implementation

`daemon` reads the current block context, interpolates eval bindings into the
content, builds the command, and forks it into the component's `evalScope` via
`@effectionx/scope-eval`. It returns immediately with empty output:

```typescript
import { daemon } from "@effectionx/process";

export const daemonFactory: ModifierFactory = (_params) =>
  (_args, _next) => (function* () {
    const ctx = yield* useCodeBlock();
    const evalScope = yield* ephemeral(EvalScopeCtx.expect());

    // ctx.content is already interpolated by the expansion engine before
    // the modifier chain runs — no interpolation needed here.
    const command = buildCommand(ctx.language, ctx.content);

    // Fork into eval scope — lifetime tied to component expansion.
    // daemon() never resolves. If the process exits prematurely,
    // daemon() throws, propagating the error to the eval scope.
    yield* evalScope.eval(function* () {
      yield* daemon(command);
    });

    // Control returns here immediately after the fork.
    return { output: "", exitCode: 0, stderr: "" };
  })();
```

### 3.4 Process lifetime

The forked task calls `daemon(command)` from `@effectionx/process`. `daemon`
spawns the process and suspends indefinitely. When the eval scope closes
(component expansion completes), the forked task is cancelled, which tears down
the daemon and terminates the subprocess.

This means:

- The process is **alive** for all blocks that follow the `daemon` block within
  the component, and for all of `<children />` expansion.
- The process is **terminated** when the component expansion ends, regardless of
  whether that ending is normal completion, an error, or cancellation from a
  parent scope.
- No explicit teardown, no finalizer registration, no lifecycle hooks are
  required — Effection's structured concurrency handles it.

### 3.5 Crash propagation

If the process exits prematurely, `daemon()` throws with a descriptive error.
This error propagates to the `evalScope`, which tears it down. The eval scope
teardown propagates to the component expansion, failing it before any child
`sample` calls are attempted.

The error surfaces at the component boundary in the document output as an
`ErrorSegment`:

```
<!-- ERROR: Daemon process exited unexpectedly (code 1): ./server -->
```

### 3.6 Replay behavior

`daemon` is not durable. It runs on every document execution, including full
replay runs. This is correct:

- On a full replay, all `sample` journal entries are present and returned
  directly — the daemon's endpoint is never called.
- The process starts, runs for the duration of expansion, and is terminated when
  the component scope closes — without serving a single request.
- This is harmless overhead; the alternative (conditional daemon startup based
  on journal state) would couple the modifier to the durable protocol.

The port allocation (`findFreePort`) is journaled as a `durableEval` export. On
replay, `env.values.port` is restored from the journal before the `daemon` block
runs, so the interpolation `{port}` produces the same port number as the
original run. The daemon binds to that same port.

---

## 4. `DurableRuntime` extension: `findFreePort`

### 4.1 Motivation

Port allocation requires OS-level socket operations whose API differs across
platforms and runtimes. `DurableRuntime` is already the established abstraction
boundary for all platform I/O in EMA (`exec`, `readTextFile`, `glob`, `fetch`).
Port allocation belongs there rather than in any platform-specific package or
baked directly into a VM global implementation.

### 4.2 Interface addition

One method is added to the `DurableRuntime` interface (§0.1 of
`effect-types.md`):

```typescript
interface DurableRuntime {
  // ... existing methods ...

  /**
   * Find an available TCP port.
   *
   * Binds a socket to an OS-assigned port, reads the port number, closes
   * the socket, and returns the port. There is a small race window between
   * close and the caller binding the port — acceptable in practice.
   *
   * If the port cannot be bound, implementations may throw or retry.
   */
  findFreePort(): Operation<number>;
}
```

Each runtime implementation provides this method using its platform's socket
API. The stub runtime used in tests returns a port from a configurable counter
or fixed value.

### 4.3 VM global

`findFreePort` is exposed in the eval VM sandbox as a thin wrapper that reads
the runtime from scope context:

```typescript
function* findFreePort(): Operation<number> {
  const scope = yield* useScope();
  const runtime = scope.expect(DurableRuntimeCtx);
  return yield* runtime.findFreePort();
}
```

This wrapper is added to the `createEvalContext` sandbox alongside the existing
Effection globals. Eval blocks call `yield* findFreePort()` without any import.

The returned port number is a JSON-serializable primitive. It is exported by the
eval block into `env.values` and journaled as part of the `durableEval` result.
On replay, the stored value is restored to `env.values` without calling
`runtime.findFreePort()` again — the runtime is not touched.

---

## 5. VM context additions

The `createEvalContext` sandbox (§4.2 of the main spec) gains one addition:

```typescript
const sandbox = {
  // ... existing globals (sleep, spawn, call, resource, useScope, when, etc.) ...
  findFreePort,  // delegates to DurableRuntime.findFreePort() via scope
};
```

`when` from `@effectionx/converge` is already present in the sandbox and
requires no change.

### 5.1 `when`

`when` from `@effectionx/converge` retries an inner operation with backoff
until it completes without throwing. It is the idiomatic way to poll a readiness
endpoint:

```typescript
yield* when(function* () {
  const response = yield* fetch(`http://127.0.0.1:${port}/health`);
  if (!response.ok) throw new Error(`Not ready: ${response.status}`);
});
```

`when` handles the retry loop, backoff, and timeout internally.

---

## 6. Provider component pattern

### 6.1 Structure

A provider component is a regular markdown component whose body follows a
three-block pattern:

1. An `eval` block that allocates resources and exports bindings (port, URLs).
2. A `daemon` block that starts the background process using those bindings.
3. An `eval` block that polls for readiness using `converge`.
4. `<children />` — the subtree that uses the running process.

````markdown
---
inputs:
  model:
    type: string
    required: true
---

```ts eval
const port = yield* findFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
```

```bash daemon exec
{props.model} --server --port {port} --nobrowser
```

```ts eval
yield* when(function* () {
  const response = yield* fetch(`${baseUrl}/health`);
  if (!response.ok) throw new Error(`Not ready: ${response.status}`);
});
```

<children />
````

### 6.2 Execution sequence

**Block 1 — resource allocation:**
`findFreePort()` delegates to `runtime.findFreePort()`. The eval block exports
`port` and `baseUrl` to `env.values`. `durableEval` journals the result:

```json
{ "type": "eval", "name": "eval:LlamafileProvider:0" }
{ "status": "ok", "value": { "value": { "port": 49821, "baseUrl": "http://127.0.0.1:49821" }, ... } }
```

**Block 2 — daemon spawn:**
`{port}` is substituted from `env.values` into the command content before
`buildCommand` runs. The resulting command is forked into the eval scope.
Control returns immediately. No journal entry.

**Block 3 — readiness:**
`when` polls `{baseUrl}/health` with retries until the server responds.
`durableEval` journals the result:

```json
{ "type": "eval", "name": "eval:LlamafileProvider:1" }
{ "status": "ok", "value": { "value": {}, ... } }
```

**`<children />`:**
Child expansion runs with the server alive and ready. `sample` calls in children
reach the server at `baseUrl`.

**Component scope closes:**
The eval scope closes. The daemon task is cancelled. The subprocess is
terminated.

### 6.3 How `sample` middleware accesses the server

The `sample` modifier delegates to the Sample Api (§3.4 of the main spec). A
middleware layer reads the server URL from `env.values`, which is on the scope
and accessible to all middleware running within the component's expansion:

```typescript
scope.around(Sample, {
  *sample([context], next): Operation<string> {
    const env = yield* ephemeral(EvalEnvCtx.expect());
    const baseUrl = env.values.baseUrl as string;
    return yield* callLLM(baseUrl, context);
  },
});
```

Because `EvalEnvCtx` is set on the component's scope via `Context.with()`, this
middleware correctly reads the `baseUrl` that belongs to the enclosing provider
component — not a sibling or parent provider's value. No additional context key,
no dedicated inference server context, no global state.

### 6.4 Nesting providers

Provider components nest naturally — each establishes its own eval scope
boundary:

```markdown
<LlamafileProvider model="./phi3-mini.llamafile">
  <DatabaseProvider url={props.dbUrl}>
    <MyReport />
  </DatabaseProvider>
</LlamafileProvider>
```

`LlamafileProvider` expands first, starts the inference server, then expands
its children. During that expansion, `DatabaseProvider` starts its own
background process. Both providers' scopes are nested — the inner provider is
torn down before the outer, in standard structured concurrency order. No
coordination between providers is required.

### 6.5 Replay behavior of the provider pattern

On full replay (all `eval` and `sample` journal entries present):

- Block 1 (`findFreePort`): `durableEval` returns the stored result. `port` and
  `baseUrl` are restored to `env.values`. `runtime.findFreePort()` is not
  called.
- Block 2 (`daemon exec`): `daemon` runs regardless — the process starts and
  binds to the stored port (the same number, which is free again since the
  previous run ended). No journal entry.
- Block 3 (`when`): `durableEval` returns the stored result immediately. No
  polling. The server may not be ready yet — but since all `sample` entries in
  children are also replayed, no HTTP request is ever made.
- `<children />`: all durable effects replay from the journal. Zero live calls.
- Component closes: daemon terminated.

Total overhead on full replay: one daemon process started and terminated after
children finish replaying. This is a known tradeoff (Decision 38).

---

## 7. Test plan

### Tier P — Eval binding interpolation

| # | Test | Verify |
|---|------|--------|
| P1 | Bare binding resolves from `env.values` | `{port}` with `env.values.port = 49821` → `"49821"` in content |
| P2 | Bare binding with no env entry left verbatim | `{port}` with no `port` in `env.values` → `"{port}"` unchanged |
| P3 | Bare binding does not match namespaced refs | `{meta.title}` and `{props.name}` not affected by eval binding pass |
| P4 | Multiple bindings in one content | `{host}:{port}` → both substituted |
| P5 | Non-string binding converted via `String()` | `env.values.port = 49821` (number) → `"49821"` |
| P6 | Binding interpolation runs before `buildCommand` | Resulting command string contains substituted value |
| P7 | On replay, env restored before interpolation | `durableEval` result restores `port`; subsequent block interpolates correctly |
| P8 | Non-serializable binding not restored on replay | Function in `env.values` not present after replay; bare `{fn}` left verbatim |

### Tier Q — `daemon` modifier

| # | Test | Verify |
|---|------|--------|
| Q1 | `daemon` ignores `next` | `exec` in chain never called — no `durableExec` invocation |
| Q2 | `daemon` produces no journal entry | Journal has no entry for `daemon` block |
| Q3 | `daemon` returns empty output | `result.output === ""`, `exitCode === 0` |
| Q4 | Process forked into eval scope | Process alive during `<children />` expansion |
| Q5 | Process terminated when component scope closes | After expansion, process is not running |
| Q6 | Process terminated on component error | If child expansion throws, process still terminated |
| Q7 | Process terminated on parent cancellation | If parent scope cancelled, process terminated |
| Q8 | Premature exit propagates as error | Process exits during expansion → `daemon()` throws → `ErrorSegment` in output |
| Q9 | `{port}` interpolation in daemon content | Binding from preceding `eval` block substituted into command |
| Q10 | `daemon` without eval scope | Missing `EvalScopeCtx` → clear error |
| Q11 | Modifier chain: `bash daemon exec` | `daemon` is outermost terminal; `exec` present but never called |
| Q12 | Replay: daemon starts and stops | On full replay, process spawned and terminated; no live `sample` calls made |
| Q13 | Replay: stored port used | `env.values.port` restored from journal; daemon binds same port |

### Tier R — VM globals and `DurableRuntime`

| # | Test | Verify |
|---|------|--------|
| R1 | `findFreePort` accessible in eval block | `yield* findFreePort()` succeeds, returns a number |
| R2 | `findFreePort` delegates to runtime | VM global calls `runtime.findFreePort()`, not a platform API directly |
| R3 | `findFreePort` returns usable port | Returned port is bindable |
| R4 | `findFreePort` not called on replay | `durableEval` returns stored port; runtime method not invoked |
| R5 | Stub runtime returns configurable port | `stubRuntime({ findFreePort: function*() { return 9999; } })` → port 9999 |
| R6 | `when` accessible in eval block | `yield* when(fn)` retries until fn succeeds |
| R7 | `when` retries on throw | Inner function throws twice, then succeeds → `when` resolves |
| R8 | `when` propagates timeout | Inner function never succeeds → `when` throws after limit |

### Tier S — Provider component pattern (integration)

| # | Test | Verify |
|---|------|--------|
| S1 | Full provider golden run | eval → daemon → when → children → cleanup |
| S2 | Port flows from eval to daemon | `{port}` in daemon content matches `findFreePort()` result |
| S3 | Children can call sample after daemon ready | `sample` calls in children reach daemon endpoint |
| S4 | Daemon terminated after children expand | After `runDocument` completes, process not running |
| S5 | Provider crash during `when` | Daemon exits before ready → `when` fails → `ErrorSegment` |
| S6 | Provider crash during children | Daemon exits mid-child-expansion → error propagated |
| S7 | Nested providers | Outer + inner provider → both start, inner tears down first |
| S8 | Full replay of provider component | All eval and sample entries replayed; daemon starts and stops; no live HTTP calls |
| S9 | Partial replay (children not yet journaled) | eval+daemon+when replayed; children run live with daemon available |
| S10 | Multiple provider instances in parallel | Two provider siblings → two processes, different ports |

---

## 8. File locations

| File | Contents |
|---|---|
| `src/expand.ts` | `interpolateEvalBindings()` — called in `expandSegments` before `composeModifierChain` |
| `src/modifiers/daemon.ts` | `daemonFactory` |
| `src/eval-context.ts` | Add `findFreePort` to sandbox |
| `@effectionx/durable-effects` | `DurableRuntime.findFreePort()` — interface addition and runtime implementations |
| `@effectionx/process` | `daemon()` |
| `@effectionx/converge` | `when()` — already a VM global, no change required |
| `@effectionx/scope-eval` | `evalScope.eval()` |

---

## 9. Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 36 | `daemon` is a terminal modifier that ignores `next` | Process lifetime ≠ command result; `exec` in the chain satisfies the §3.2 detection rule without invoking `durableExec` |
| 37 | `daemon` uses `evalScope`, not the durable run scope | Lifetime matches component expansion — daemon lives for `<children />` and dies with the component, not the whole document run |
| 38 | `daemon` produces no journal entry | The process is an ephemeral resource; restarting it on every run including replay is correct since replayed `sample` calls never reach the server |
| 39 | Eval binding interpolation uses bare `{name}` syntax | Distinct from `{meta.key}` and `{props.key}` namespaces; local eval bindings are local variables, not namespaced data; regex excludes names containing `.` to avoid conflicts |
| 40 | Eval binding interpolation runs in the expansion engine, not inside modifier factories | Modifiers transform execution results — they are not responsible for preparing source text; one interpolation site in `expandSegments` is consistent with how text segment interpolation already works, and keeps modifier factories free of knowledge about the binding environment |
| 41 | `findFreePort` is a VM global backed by `DurableRuntime` | Port allocation is platform I/O — it belongs on the same abstraction boundary as `exec`, `readTextFile`, and `glob`; the VM global is a thin scope-reading wrapper that delegates to the runtime |
| 42 | `findFreePort` result journaled via `durableEval`, not as its own durable effect | The port number is a scalar export from the eval block; it round-trips through the journal as part of `durableEval`'s `value.value`; no separate effect type or journal entry needed |
| 43 | `when` (from `@effectionx/converge`) is the polling VM global | `when` is the exported name from the package; the sandbox already contains it; no rename or addition needed |
| 44 | Provider lifecycle expressed as a component, not a `RunDocumentOptions` field | Scope boundary is visible in the document tree; composable — multiple providers nest naturally via structured concurrency; no framework-level lifecycle hooks required; eliminates `SampleProvider` interface |
| 45 | Readiness check is a separate `eval` block, not internal to `daemon` | Auditable — strategy visible in the document; replaceable — different daemons have different readiness signals; composable with `converge`'s configurable backoff |
| 46 | Sample middleware reads `baseUrl` from `env.values` | Avoids a dedicated inference server context key; `EvalEnvCtx` is already the shared state carrier for within-component coordination; scope-correct because `EvalEnvCtx` is set per component expansion |
