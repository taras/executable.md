# Executable MDX: Decision Log

Decisions made during implementation, including learnings discovered along the way.

---

## DEC-001: `Workflow<T>` vs `Operation<T>` — the type boundary

**Status:** Decided  
**Date:** 2026-03-08

### Context

`@effectionx/durable-streams` defines:
```typescript
type Workflow<T> = Generator<DurableEffect<unknown>, T, unknown>;
```

This is structurally incompatible with Effection's `Operation<T>`:
```typescript
type Operation<T> = Generator<Effect<unknown>, T, unknown>;
```

A `Workflow<T>` can only `yield` `DurableEffect` values (which get journaled).
An `Operation<T>` can only `yield` `Effect` values (Effection infrastructure).

These two generator yield types don't overlap — you can't mix them freely.

### Problem discovered

When writing `durableImportComponent`, the inner function passed to
`createDurableOperation<T>(desc, execute)` must be `() => Operation<T>` — it
runs inside Effection's structured concurrency and yields `Effect` values
(e.g., `yield* runtime.readTextFile(path)`).

But the outer function (`durableImportComponent` itself) must be a
`Workflow<T>` because it `yield`s the `DurableEffect` returned by
`createDurableOperation`.

The expansion engine generators (`expandSegments`, `expandComponent`) are
neither pure `Workflow` nor pure `Operation` — they `yield*` into both
worlds (durable effects from import/exec, and non-journaled runtime work).

### Decision

Use `ephemeral()` from `@effectionx/durable-streams` to bridge the gap.
`ephemeral(op)` wraps an `Operation<T>` so it can be called inside a
`Workflow<T>` — the operation runs but produces no journal entries. It's
the explicit escape hatch for non-durable work inside a durable workflow.

**Pattern:**
```typescript
function* myWorkflow(): Workflow<string> {
  // This yields a DurableEffect — gets journaled
  const data = yield* durableCall("fetch", () => fetchData());
  
  // This is an Operation — use ephemeral to bridge
  const parsed = yield* ephemeral(parseData(data));
  
  return parsed;
}
```

**For `createDurableOperation`:**
The `execute` parameter is `() => Operation<T>` — inside it, you use
normal Effection operations (`yield* runtime.readTextFile()`). The
`createDurableOperation` call itself produces a `DurableEffect<T>` which
is yielded in the `Workflow` context.

### Lesson learned

This distinction should have been understood before starting implementation.
The type system enforces a clear boundary between "journaled effects" and
"infrastructure operations" — this is a feature, not a bug. It prevents
accidentally mixing durable and non-durable yields.

---

## DEC-002: Expansion generators are Workflows

**Status:** Decided  
**Date:** 2026-03-08

### Context

`expandSegments` and `expandComponent` need to yield durable effects
(via `durableImportComponent`, exec modifier chain) and also perform
non-journaled work (interpolation, validation, parsing).

### Decision

The expansion generators are typed as `Workflow<T>` since they yield
`DurableEffect` values. Non-journaled work (interpolation, validation)
is done as plain function calls — no `yield` needed since they're
synchronous and deterministic.

For any async/Operation work needed inside expansion (e.g., if we ever
need to call runtime APIs directly), use `ephemeral()`.

---

## DEC-003: Modifier middleware return type

**Status:** Decided (updated by DEC-006)  
**Date:** 2026-03-08

### Context

Modifier middleware compose into chains. Terminal handlers (`exec`)
yield `DurableEffect` values (via `createDurableOperation`). Wrapping
handlers (`silent`) call `next()` which runs the inner chain.

### Decision

Each modifier is a `ModifierFactory` that returns a
`Middleware<[], CodeBlockWorkflow>`. The `CodeBlockWorkflow` type is
`Workflow<CodeBlockResult>` — a generator that yields `DurableEffect`
values and returns a `CodeBlockResult`.

```typescript
type CodeBlockWorkflow = Workflow<CodeBlockResult>;
type ModifierMiddleware = Middleware<[], CodeBlockWorkflow>;
type ModifierFactory = (params: string | undefined) => ModifierMiddleware;
```

See DEC-006 for the full rationale behind this signature change.

---

## DEC-004: Resolver uses Operation inside createDurableOperation

**Status:** Decided  
**Date:** 2026-03-08

### Context

Component resolution needs filesystem access (`runtime.stat()`).
The spec says resolution runs inside `durableImportComponent`'s
`createDurableOperation` body, so resolve and read form a single journaled
operation.

### Decision

The resolver function returns `Operation<ResolveResult>` (not `Workflow`),
because it runs inside the `execute` body of `createDurableOperation`
where only `Operation` yields are valid.

The `durableImportComponent` function is a `Workflow` — it yields the
`DurableEffect` from `createDurableOperation`.

```
Workflow context:          durableImportComponent
  yields DurableEffect:      createDurableOperation(desc, execute)
    Operation context:         execute() — resolver, readTextFile
      yields Effect:             runtime.stat(), runtime.readTextFile(), etc.
```

---

## DEC-005: Preview package isolation

**Status:** Decided  
**Date:** 2026-03-08

### Context

`@effectionx/durable-streams` is maintained in this repository as an
experimental implementation detail. Its API may change.

### Decision

Keep stream protocol integration in the execution boundary
(`src/run-document.ts`, `src/eval-handler.ts`, and terminal effect handlers).
All other modules (scanner, frontmatter, expand, interpolate, validate,
render) have zero dependency on the stream package.

The expansion engine reaches import and modifier execution through the
contextual Component Api (DEC-012) — it doesn't know about durable
effects. The document's providers, installed by `run-document.ts`, are
the only place expansion meets the stream protocol.

---

## DEC-006: Modifier middleware alignment with Effection v4.1

**Status:** Decided  
**Date:** 2026-03-09

### Context

The original `ModifierHandler` type was:

```typescript
type ModifierHandler = (
  context: CodeBlockContext,
  params: string | undefined,
  next: () => Workflow<CodeBlockResult>,
) => Workflow<CodeBlockResult>;
```

This had two problems:

1. **`context` was a handler parameter.** Effection has a first-class
   `Context` system for scope-inherited values. Passing the code block
   context as a function argument bypassed this — every handler received
   data it might not need, and the signature didn't match Effection's
   middleware shape.

2. **The signature didn't match `Middleware<TArgs, TReturn>`.** Effection
   v4.1's Api system uses `(args: TArgs, next: (...args: TArgs) => TReturn) => TReturn`.
   Our three-argument `(context, params, next)` was a custom shape that
   couldn't be composed with the same `combine()` primitive.

### Decision

Three changes:

**1. Reusable middleware primitive (`@effectionx/middleware`):**

```typescript
type Middleware<TArgs extends unknown[], TReturn> = (
  args: TArgs,
  next: (...args: TArgs) => TReturn,
) => TReturn;
```

Plus a `combine()` function matching Effection's `api-internal.ts`.
This is decoupled from modifier-specific types and reusable for any
future middleware scenario. Originally implemented as `src/middleware.ts`,
this was extracted to the `@effectionx/middleware` shared package.

**2. Factory pattern for modifier registration:**

```typescript
type ModifierMiddleware = Middleware<[], CodeBlockWorkflow>;
type ModifierFactory = (params: string | undefined) => ModifierMiddleware;
```

Each registered modifier is a factory. When the chain is composed,
the factory is called with the parsed params from the info string
(e.g., `"brief"` from `sample=brief`). The returned middleware
conforms to `Middleware<[], ...>` — no arguments flow through `next`,
params are captured in the factory closure.

**3. Contextual delivery of code block metadata:**

The block's `CodeBlockContext` is delivered through the Component Api
(DEC-012): `composeModifierChain` installs a scope-local `codeBlock()`
provider for the duration of the chain, and handlers that need the
code block info (language, content, componentName) call `useCodeBlock()`
instead of receiving it as a parameter. The `ephemeral()` bridge makes
this work inside durable workflow generators (see DEC-001).

### Why a scope-local provider instead of `Context.set()`

A provider installed inside the chain's own scope is removed when that
scope exits. This is the correct primitive because:

- Each code block gets its own context for the duration of its chain
- No context leaks between code blocks
- The chain runs inside `ephemeral()` which bridges the Operation
  world (where Context lives) with the Workflow world (where durable
  effects are yielded)

### Lesson learned

When building middleware systems, start from the target middleware type
(`Middleware<TArgs, TReturn>`) and derive the domain-specific types
from it — not the other way around. The original design started from
the domain (what does a modifier handler need?) and ended up with a
custom shape that didn't compose with the rest of the framework.

---

## DEC-007: Provider readiness uses `fetch().expect()`

**Status:** Decided  
**Date:** 2026-03-10

### Context

The provider component pattern (spec §6.7) uses `when()` from
`@effectionx/converge` to poll a daemon's readiness endpoint. The
original readiness check was:

```typescript
yield* when(function* () {
  const response = yield* fetch(baseUrl + '/health');
  if (!response.ok) throw new Error('Not ready: ' + response.status);
}, { timeout: 5000, interval: 50 });
```

`@effectionx/fetch` provides a `.expect()` method that throws
`HttpError` on non-2xx responses, making the manual `response.ok`
check redundant.

### Decision

Use `fetch(url).expect()` inside `when()` for readiness polling:

```typescript
yield* when(function* () {
  yield* fetch(baseUrl + '/health').expect();
}, { timeout: 5000, interval: 50 });
```

**Why this works:**

1. `.expect()` throws `HttpError` on non-2xx status codes
2. Network-level errors (connection refused before daemon is listening)
   throw natively from the underlying `globalThis.fetch`
3. `when()` in non-always mode catches any thrown error and retries at
   the configured interval until the assertion passes or timeout expires
4. `.expect()` returns a fresh `FetchOperation` per iteration — no
   leftover state or dangling resources between retries

**Convention:** All provider readiness checks should use
`fetch().expect()` rather than manual `response.ok` checks. This
keeps the pattern concise (one line instead of three) while preserving
identical behavior.

---

## DEC-008: `output()` is a synchronous function, not `yield*`

**Status:** Decided  
**Date:** 2026-03-11

### Context

Eval blocks needed a way to produce rendered output (for the Sample
component pattern). Two approaches were considered:

1. `yield* output("text")` — an Effection operation
2. `output("text")` — a plain function call

### Decision

`output()` is a plain synchronous function. It mutates a block-local
`outputRef` object. The output text is journaled alongside exports as
`__output` in the eval operation result.

**Why plain function:** Output is a synchronous side effect (setting a
string value), not an async operation. Making it a generator would
require the block to be in generator mode just to set output, which is
unnecessarily restrictive. A plain function keeps the API simple.

**Why `__output` in exports:** Avoids a separate journal entry type for
output text. `__output` is extracted before merging into `env.values` to
prevent namespace pollution.

---

## DEC-009: `renderChildren`/`render` are closures, not an Api

**Status:** Decided  
**Date:** 2026-03-11

### Context

Components needed a way to capture their children's rendered output
(for the Sample component). Two patterns were considered:

1. A Render Api with middleware installation
2. Closure functions injected into `env.values`

### Decision

Closures injected into `env.values` at component expansion time. They
capture the expansion context (meta, props, hide set, eval scope) and
install the caller's binding environment and eval scope as scope-local
Component providers (DEC-012) around their `expandSegments` calls.

**Why closures, not an Api:** A Render Api would require middleware
installation per component and add a new Api type to the system.
Closures are simpler — they're injected once during `expandComponent`
and naturally capture all needed context. They're non-serializable,
so `serializeExports` silently omits them from the journal.

**Why provider installation inside the closure:** The closures may be
called from inside `evalScope.eval()`, where the ambient scope differs
from the expansion scope. Installing the providers at call time ensures
the correct environment and eval scope are visible regardless of the
calling task.

---

## DEC-011: Sample component props use empty-string defaults

**Status:** Decided
**Date:** 2026-03-11

### Context

The Sample component has three optional props: `prompt`, `model`,
`params`. When a prop is optional with no default and not provided,
`validateProps` does not include it in `env.values` (line 81:
"Optional with no default and not provided → not in validated").
This means the variable is not defined in the eval block scope,
causing `ReferenceError`.

### Decision

All three props use `default: ""` in the frontmatter. The eval block
converts empty strings to `undefined` for routing semantics:
`model || undefined`, `params || undefined`.

**Why not `required: false` alone:** Without a default value, the
variable simply doesn't exist in `env.values`, so `transformBlock`
doesn't include it in the preamble. The eval block would get
`ReferenceError: params is not defined`.

**Why empty string, not undefined:** YAML `null` with `required: false`
still doesn't add the key to validated props. Empty string is a
legitimate default that ensures the key exists. The `|| undefined`
conversion preserves the distinction between "not provided" and "empty"
for provider routing (providers check `context.model !== undefined`).

---

## DEC-012: Component Api replaces dependency threading and raw operational contexts

**Status:** Decided

### Context

Expansion originally received its dependencies through an
`ExpansionContext` object (`importComponent`, `runModifierChain`)
threaded as a parameter into every recursive expansion call, while the
remaining operational state traveled through raw Effection context keys
(`EvalEnvCtx`, `EvalScopeCtx`, `CodeBlockCtx`, `PersistFlagCtx`,
`ContentCtx`, `ErrorPolicyCtx`). Two delivery mechanisms meant two
override models: replacing an import strategy required constructing a
new container at the call site, while overriding scope state required
knowing which raw key to set — and neither surface was wrappable for
instrumentation.

### Decision

One public Api — `Component` (`ComponentApi`) backed by
`@effectionx/context-api` — carries every context-dependent operation:
`importComponent`, `applyModifiers`, `raise`, `env`, `evalScope`,
`codeBlock`, `persistent`, `content`. The `ctx` parameter is gone from
the expansion signatures, and the raw operational keys are removed from
the public surface. `useCodeBlock()` and `useContent()` remain as
ergonomic aliases.

**Why middleware at `min` for implementations:** middleware installed
in a nested scope runs before inherited middleware, so a component's
own `env`/`evalScope` providers shadow its ancestors' by
short-circuiting — and installing inside `scoped()` removes them on
exit, so siblings never observe each other's state. Runtime providers
(document import, modifier execution, per-component state, error
policy) all install at `min`.

**Why `max` for instrumentation:** `max` middleware wraps outside every
implementation, so tracing, mocking, and overrides can observe or
transform calls without caring which `min` provider is active, and can
delegate with `next(...)` or short-circuit.

**Why defaults instead of mandatory providers:** operations with a
sensible neutral value default to it (`raise` returns the segment,
`env()`/`evalScope()` are undefined, `persistent()` is false), while
operations that cannot proceed without a provider (`importComponent`,
`applyModifiers`, `codeBlock`, `content`) throw named missing-provider
errors that identify the missing installation.

Durable-streams' own contexts (e.g. `DurableCtx`) are unchanged: they
store durable runtime state, not overridable core operations.
