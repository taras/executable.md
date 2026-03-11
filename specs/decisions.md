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
`createDurableOperation` body — the entire resolve+read+hash is a
single journaled effect.

### Decision

The resolver function returns `Operation<ResolveResult>` (not `Workflow`),
because it runs inside the `execute` body of `createDurableOperation`
where only `Operation` yields are valid.

The `durableImportComponent` function is a `Workflow` — it yields the
`DurableEffect` from `createDurableOperation`.

```
Workflow context:          durableImportComponent
  yields DurableEffect:      createDurableOperation(desc, execute)
    Operation context:         execute() — resolver, readTextFile, SHA-256
      yields Effect:             runtime.stat(), runtime.readTextFile(), etc.
```

---

## DEC-005: Preview package isolation

**Status:** Decided  
**Date:** 2026-03-08

### Context

`@effectionx/durable-streams` and `@effectionx/durable-effects` are
installed from `pkg.pr.new` preview URLs (PR #179 and #180). These
are pre-release and may change.

### Decision

Import from these packages only in `src/run-document.ts` (the integration
layer). All other modules (scanner, frontmatter, expand, interpolate,
validate, render) have zero dependency on the durable packages. This
means API changes in the preview packages only affect one file.

The expansion engine accepts abstract `ComponentImporter` and
`ModifierChainRunner` functions — it doesn't know about durable effects.
This was a good architectural decision that happened naturally.

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

**3. Effection Context for code block metadata:**

```typescript
const CodeBlockCtx = createContext<CodeBlockContext>("codeBlock");
function useCodeBlock(): Workflow<CodeBlockContext> {
  return ephemeral(CodeBlockCtx.expect());
}
```

`composeModifierChain` sets the context via `CodeBlockCtx.with()`,
which scopes the value to the chain execution. Handlers that need the
code block info (language, content, componentName) call `useCodeBlock()`
instead of receiving it as a parameter. The `ephemeral()` bridge makes
this work inside durable workflow generators (see DEC-001).

### Why `CodeBlockCtx.with()` instead of `Context.set()`

`Context.with(value, operation)` scopes the value to the operation's
lifetime and restores the previous value when done. This is the correct
primitive because:

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
`__output` in the `durableEval` result.

**Why plain function:** Output is a synchronous side effect (setting a
string value), not an async operation. Making it a generator would
require the block to be in generator mode just to set output, which is
unnecessarily restrictive. A plain function keeps the API simple.

**Why `__output` in exports:** Avoids a separate journal entry type for
output text. The output naturally replays when `durableEval` restores
the stored result. `__output` is extracted before merging into
`env.values` to prevent namespace pollution.

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
wrap their `expandSegments` calls in `EvalEnvCtx.with()` and
`EvalScopeCtx.with()`.

**Why closures, not an Api:** A Render Api would require middleware
installation per component and add a new Api type to the system.
Closures are simpler — they're injected once during `expandComponent`
and naturally capture all needed context. They're non-serializable,
so `serializeExports` silently omits them from the journal.

**Why context wrapping:** The closures may be called from inside
`evalScope.eval()`, where the Effection context is different from
the expansion context. Wrapping ensures `EvalEnvCtx` and `EvalScopeCtx`
are correctly set regardless of the calling task.

---

## DEC-010: `durableSample` extracted as shared helper

**Status:** Decided  
**Date:** 2026-03-11

### Context

The sample modifier and the Sample component both need to make
journaled calls to the Sample Api. The original implementation
inlined the `createDurableOperation` + `evalScope.eval()` logic in
the sample modifier.

### Decision

Extracted `durableSample()` to `src/sample/durable-sample.ts` as a
shared `Workflow<string>` helper. Both the sample modifier and future
callers use this single implementation.

`durableSample` returns `Workflow<string>` (not `Operation<string>`)
because it yields `DurableEffect` via `createDurableOperation`.

**Why the Sample component does NOT use `durableSample`:** The Sample
component's eval block runs inside `durableEval`'s evaluator, which
expects `Operation<Json>` yields. `durableSample` yields
`DurableEffect`s which are incompatible. Instead, the Sample component
calls `Sample.operations.sample()` directly — the entire eval block
(including its output) is journaled by `durableEval`'s mechanism.

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
