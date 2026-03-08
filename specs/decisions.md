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

## DEC-003: ModifierHandler return type

**Status:** Decided  
**Date:** 2026-03-08

### Context

`ModifierHandler` functions compose into chains. Terminal handlers
(`exec`) yield `DurableEffect` values (via `createDurableOperation`).
Wrapping handlers (`silent`) call `next()` which runs the inner chain.

### Decision

`ModifierHandler` returns `Workflow<CodeBlockResult>` since the chain
ultimately yields durable effects. The `next` parameter is also typed
as `() => Workflow<CodeBlockResult>`.

```typescript
type ModifierHandler = (
  context: CodeBlockContext,
  params: string | undefined,
  next: () => Workflow<CodeBlockResult>,
) => Workflow<CodeBlockResult>;
```

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
