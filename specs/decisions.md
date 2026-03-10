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
`Generator<unknown, CodeBlockResult, unknown>`, which is compatible
with `Workflow<CodeBlockResult>` since the chain ultimately yields
durable effects.

```typescript
type CodeBlockWorkflow = Generator<unknown, CodeBlockResult, unknown>;
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

**1. Reusable middleware primitive (`src/middleware.ts`):**

```typescript
type Middleware<TArgs extends unknown[], TReturn> = (
  args: TArgs,
  next: (...args: TArgs) => TReturn,
) => TReturn;
```

Plus a `combine()` function matching Effection's `api-internal.ts`.
This is decoupled from modifier-specific types and reusable for any
future middleware scenario.

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
