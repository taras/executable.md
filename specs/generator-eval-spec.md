# Generator eval blocks for EMA

**Status:** Draft  
**Audience:** Implementing agent  
**Inputs:** `specs/executable-mdx-spec.md`, `specs/decisions.md` (DEC-001–DEC-006),
`src/middleware.ts`, `src/modifiers.ts`, `effect-types.md` (`durableEval`,
`useCodeFreshnessGuard`), `@effectionx/durable-streams`, `@effectionx/durable-effects`,
`@effectionx/timebox`

---

## 1. Overview

This specification adds **generator eval blocks** to EMA — in-process JavaScript
code blocks that execute as Effection generator operations, share a persistent
binding environment across blocks within a component, and participate fully in
durable replay.

`eval` becomes a new terminal modifier factory, joining `exec`. Unlike `exec`
(subprocess), `eval` executes code in the same Effection process, enabling:

- Direct access to live in-memory objects
- Native `yield*` of Effection operations
- Shared state across blocks within a component via a binding env
- In-process resource management via `persist` modifier

### 1.1 Example

````markdown
```ts eval
const port = yield* findFreePort();
```

```ts persist eval
const server = yield* startServer({ port });
```

```ts eval
const response = yield* durableFetch("health-check", `http://localhost:${port}/health`);
```
````

- Block 1 runs, exports `port` to the shared env
- Block 2 runs with `persist` — the server resource stays alive after the block
  completes, bound to the component's eval-scope
- Block 3 reads `port` from env; `response` is journaled via `durableFetch`

---

## 2. Middleware pattern alignment

**Read `src/modifiers.ts` and `src/middleware.ts` in full before implementing.**
All new factories must exactly follow the pattern established there.

### 2.1 Types — already defined, do not redefine

These types live in `src/modifiers.ts`. Import them; never redefine them:

```typescript
// Already exported from src/modifiers.ts
export type CodeBlockWorkflow = Workflow<CodeBlockResult>;
export type ModifierMiddleware = Middleware<[], CodeBlockWorkflow>;
export type ModifierFactory = (params: string | undefined) => ModifierMiddleware;
```

And `Middleware<TArgs, TReturn>` + `combine()` live in `src/middleware.ts`.

### 2.2 The factory shape every new modifier must follow

```typescript
const myFactory: ModifierFactory = (params) =>
  (_args, next) => function* () {
    // params captured in the outer factory closure
    // code block info via: yield* useCodeBlock()
    // scope context via:   yield* ephemeral(SomeCtx.expect())
    // delegate inward via: yield* next()
    return yield* next();
  }();
```

The `function* () { ... }()` pattern: `ModifierMiddleware` is
`(args: [], next: () => CodeBlockWorkflow) => CodeBlockWorkflow`. The return
value must be a `CodeBlockWorkflow` (a Generator object, not a generator
function). The IIFE produces the generator directly as the arrow function's
return value.

### 2.3 Accessing code block metadata

Handlers that need code block metadata call `useCodeBlock()`, already exported
from `src/modifiers.ts`:

```typescript
const ctx = yield* useCodeBlock();
// ctx.language, ctx.content, ctx.componentName, ctx.blockId
```

Do **not** receive metadata as a parameter. See DEC-006.

### 2.4 The `ephemeral()` bridge (DEC-001)

All `Operation<T>` yields inside a modifier factory body must go through
`ephemeral()`:

```typescript
const env = yield* ephemeral(EvalEnvCtx.expect());
```

`ephemeral(op)` wraps an `Operation<T>` so it can be `yield*`'d inside a
`Workflow<T>`. Without it, yielding an `Effect` value inside a
`Workflow` generator is a type error — the boundary between journaled effects
and infrastructure operations is enforced by the type system (DEC-001).

### 2.5 Context scoping via `Context.with()`

New context values follow the same pattern already used for `CodeBlockCtx` in
`composeModifierChain`:

```typescript
yield* ephemeral(
  EvalEnvCtx.with(env, function* () {
    // EvalEnvCtx is visible here and in all generators called from here
  }),
);
```

`Context.with(value, op)` scopes the value to `op`'s lifetime and restores the
previous value when done. This prevents context leaks between blocks and between
components. See DEC-006 for the full rationale.

---

## 3. Execution architecture

### 3.1 The eval-scope

Each component gets a dedicated **eval-scope** — an Effection scope whose
lifetime matches the component's expansion:

- Created when component expansion begins
- Destroyed when component expansion completes
- Acts as the parent scope for resources spawned by `persist` blocks
- Is a child of the parent component's scope, forming a hierarchy

Stored as a Context value so modifier factories can access it:

```typescript
// src/eval-env.ts
import { createContext } from "effection";
import type { EvalScope } from "@effectionx/scope-eval";

export const EvalScopeCtx = createContext<EvalScope>("evalScope");
```

The expansion engine creates the `EvalScope` with `useEvalScope()` and scopes it
via `EvalScopeCtx.with()`, matching the same pattern as `CodeBlockCtx.with()`
in `composeModifierChain`. Resources spawned inside `evalScope.eval()` calls are
retained for the lifetime of the `EvalScope` — which is the component's expansion
lifetime:

```typescript
// Inside expandComponent — wraps all code block execution for this component
const evalScope = yield* useEvalScope();
yield* ephemeral(
  EvalScopeCtx.with(evalScope, function* () {
    yield* EvalEnvCtx.with(env, function* () {
      // ... expand code blocks in order
    });
  }),
);
// evalScope is torn down when expandComponent returns — all retained resources halted
```

### 3.2 The binding environment

```typescript
// src/eval-env.ts
export const EvalEnvCtx = createContext<EvalEnv>("evalEnv");

export interface EvalEnv {
  values: Record<string, unknown>;
}
```

Created fresh at the start of component expansion. Handlers access it via
`ephemeral(EvalEnvCtx.expect())`.

### 3.3 Single-block execution model

Each block is an independent `yield*` step — no batch loop at the executor
level. The journal middleware inside the eval handler decides replay vs. live;
the caller sees only a flat sequence:

```typescript
// Inside expandSegments, for each executable eval block:
const chain = composeModifierChain(segment.modifiers, context, registry);
const result = yield* chain();
```

Each `chain()` call is an independent durable step.

---

## 4. Source transform

### 4.1 Purpose

Top-level `const`/`let`/`function`/`class` declarations are scoped to the block
invocation. The source transform rewrites them so their values are also written
to `env`, making them available to subsequent blocks and to the journal system.

### 4.2 Transform rules

For each top-level node in `ast.body`, append an env-write immediately after:

| Statement | Transform |
|---|---|
| `const x = expr` | `const x = expr; env.x = x;` |
| `let x = expr` | `let x = expr; env.x = x;` |
| `function f() {}` | `function f() {} env.f = f;` |
| `class C {}` | `class C {} env.C = C;` |
| `const { a, b } = expr` | `const { a, b } = expr; env.a = a; env.b = b;` |
| Nested declarations | Not exported — only direct `ast.body` children |

Top-level free variable references that exist in the current `env` are injected
as a destructuring preamble:

```typescript
// If block references `port` and env.values.port exists:
const { port } = env;
```

Only names actually used as free variables are injected — not all of `env`.

### 4.3 Implementation

Use **acorn** for parsing and **magic-string** for string mutations.

```typescript
// src/eval-transform.ts
import { parse } from "acorn";
import MagicString from "magic-string";

export interface TransformResult {
  code: string;       // transformed body, without the generator wrapper
  map: string;        // V3 source map JSON
  exports: string[];  // top-level names written to env
  imports: string[];  // names read from env (free variables present in env)
  mode: "generator" | "async" | "sync";
}

export function transformBlock(
  source: string,
  blockId: string,
  currentEnvKeys: string[],
): TransformResult;
```

Transform pipeline:

1. **Parse** with acorn (`ecmaVersion: "latest"`, `sourceType: "module"`)
2. **Detect mode** — §4.4
3. **Collect exports** — walk `ast.body`; extract bound names from each
   top-level declaration, recursively unpacking destructuring patterns
4. **Collect imports** — find free variable references in `currentEnvKeys`
5. **Build preamble** — `const { a, b } = env;` for each imported name
6. **Append env-writes** — `env.x = x;` after each top-level declaration
   via `s.appendLeft(node.end, ...)`
7. **Append** `//# sourceURL=eval:${blockId}` for debugger identification
8. **Generate** source map via `s.generateMap({ source: blockId, hires: true })`

Produces the **body** of the generator function. The `function*(env) {` wrapper
is added by `compileBlock` (§5.2), not here.

### 4.4 Execution mode auto-detection

Mode is detected from the AST — **no modifier needed**:

| Condition | Mode |
|---|---|
| Top-level `yield` expression in `ast.body` | `"generator"` |
| Top-level `await` expression in `ast.body` | `"async"` |
| Neither | `"sync"` |

Only direct children of `ast.body` are inspected. `yield`/`await` inside nested
function bodies do **not** count.

A block with both top-level `yield` and top-level `await` is a transform-time
error:

```
Error in block eval:block-3: cannot mix `yield*` and `await` at the top level.
Use `yield* call(async () => { ... })` to bridge async code into a generator block.
```

### 4.5 Generator wrapping

All blocks are wrapped in a generator function by `compileBlock`. Async and sync
modes are bridged inside the generator body:

```typescript
// Generator mode — native yield* in body
(function*(env) {
  const { existingBinding } = env;
  const x = yield* someOperation(); env.x = x;
  //# sourceURL=eval:block-1
})

// Async mode — transform wraps user code in call()
(function*(env) {
  const { existingBinding } = env;
  const result = yield* call(async () => {
    const x = await someAsyncThing();
    return x;
  }); env.result = result;
  //# sourceURL=eval:block-2
})

// Sync mode — no yield needed
(function*(env) {
  const { existingBinding } = env;
  const x = computeSomething(); env.x = x;
  //# sourceURL=eval:block-3
})
```

---

## 5. VM context

### 5.1 One shared context per document run

A single `vm.Context` is created at document run start and reused for all eval
blocks across the entire document. Context creation is expensive (~7–21ms).

```typescript
// src/eval-context.ts
import { createContext as createEffectionContext } from "effection";
import { createContext as vmCreateContext } from "node:vm";

export interface EvalContext {
  vmContext: object;
}

export const EvalCtxKey = createEffectionContext<EvalContext>("evalContext");

export function createEvalContext(
  globals: Record<string, unknown> = {},
): EvalContext {
  const sandbox = {
    // Effection APIs available in blocks without import
    sleep, spawn, call, ensure, resource, useScope,
    // Standard globals
    console,
    // Host-provided extras
    ...globals,
  };
  return { vmContext: vmCreateContext(sandbox) };
}
```

Set on the root document scope so all eval blocks share the same VM context.
Handlers access it via `ephemeral(EvalCtxKey.expect())`.

### 5.2 Compiling blocks

```typescript
// src/eval-context.ts
import { runInContext } from "node:vm";

export function compileBlock(
  transformedBodyCode: string,
  vmContext: object,
): (env: Record<string, unknown>) => Generator<unknown, void, unknown> {
  return runInContext(
    `(function*(env) { ${transformedBodyCode} })`,
    vmContext,
  );
}
```

---

## 6. The `eval` terminal modifier factory

### 6.1 Role

`eval` is a **terminal modifier factory** — same role as `createExecFactory`.
It ignores `next` and performs the actual in-process evaluation. Compare the
shape directly to `createExecFactory` in `executable-mdx-spec.md` §3.3.

### 6.2 Implementation

```typescript
// src/eval-handler.ts
import { ephemeral } from "@effectionx/durable-streams";
import { durableEval } from "@effectionx/durable-effects";
import type { ModifierFactory } from "./modifiers.ts";
import { useCodeBlock } from "./modifiers.ts";
import { EvalEnvCtx, EvalCtxKey } from "./eval-env.ts";
import { transformBlock, serializeExports } from "./eval-transform.ts";
import { compileBlock } from "./eval-context.ts";

export const evalFactory: ModifierFactory = (_params) =>
  (_args, _next) => function* () {
    const ctx = yield* useCodeBlock();
    const env = yield* ephemeral(EvalEnvCtx.expect());
    const evalCtx = yield* ephemeral(EvalCtxKey.expect());

    const transformed = transformBlock(
      ctx.content,
      ctx.blockId,
      Object.keys(env.values),
    );

    const result = yield* durableEval(
      `eval:${ctx.blockId}`,
      function* (source, bindings) {
        // Merge incoming bindings snapshot into env before execution
        Object.assign(env.values, bindings);
        const fn = compileBlock(source, evalCtx.vmContext);
        yield* fn(env.values);
        return serializeExports(env.values, transformed.exports);
      },
      {
        source: transformed.code,
        language: ctx.language,
        bindings: serializeExports(env.values, transformed.imports),
      },
    );

    // On replay, restore serializable exports from the journal
    if (result.value && typeof result.value === "object") {
      Object.assign(env.values, result.value);
    }

    return { output: "", exitCode: 0, stderr: "" };
  }();
```

`eval` produces no rendered output — eval blocks are binding and side-effect
producers, not content producers.

### 6.3 Binding serialization

```typescript
// src/eval-transform.ts
import type { Json } from "@effectionx/durable-streams";

export function serializeExports(
  env: Record<string, unknown>,
  names: string[],
): Record<string, Json> {
  const result: Record<string, Json> = {};
  for (const name of names) {
    const value = env[name];
    if (isJson(value)) {
      result[name] = value as Json;
    }
    // Non-serializable values silently omitted.
    // They remain in env.values as live references during this run
    // but are absent from the journal and not restored on replay.
  }
  return result;
}
```

### 6.4 Detection rule update

In the `parseInfoString` function (already in `src/modifiers.ts`):

```typescript
executable: modifiers.some(m => m.name === "exec" || m.name === "eval"),
```

No other parser change needed.

### 6.5 `blockId` in `CodeBlockContext`

Add to the existing interface in `src/types.ts`:

```typescript
interface CodeBlockContext {
  language: string;
  content: string;
  blockId: string;          // NEW — unique within the document run
  componentName?: string;
}
```

Assigned during segment construction: `eval:${componentName ?? "root"}:${index}`.

---

## 7. New wrapping modifier factories

All follow the factory shape from §2.2. Read `silentFactory` and `sampleFactory`
in `executable-mdx-spec.md` §3.3 as the canonical reference before implementing.

### 7.1 `persist`

Extends resource lifetime from block scope to the component's eval-scope. By
default, resources spawned inside a block's operation are scoped to that block's
execution — they are torn down when the block's generator returns. With `persist`,
the block's operation runs via `evalScope.eval()` from `@effectionx/scope-eval`,
which retains spawned resources in the persistent `EvalScope` until the component
finishes expanding.

```typescript
// src/modifiers/persist.ts
import { ephemeral } from "@effectionx/durable-streams";
import { unbox } from "@effectionx/scope-eval";
import type { ModifierFactory } from "../modifiers.ts";
import { EvalScopeCtx } from "../eval-env.ts";
import type { CodeBlockResult } from "../types.ts";
import type { Operation } from "effection";

export const persistFactory: ModifierFactory = (_params) =>
  (_args, next) => function* () {
    const evalScope = yield* ephemeral(EvalScopeCtx.expect());
    // evalScope.eval() runs the operation in the persistent scope,
    // retaining any resources spawned during next() for the component lifetime.
    const result = yield* ephemeral(
      evalScope.eval(() => next() as unknown as Operation<CodeBlockResult>),
    );
    return unbox(result);
  }();
```

`persist` affects **resource lifetime**, not execution flow. The block still
completes and returns its result before the next block starts.

### 7.2 Modifier combinations

| Info string | Behavior |
|---|---|
| `ts eval` | Block completes before next; spawned resources torn down at block end |
| `ts persist eval` | Block completes before next; spawned resources live until component ends |

### 7.3 `timeout`

`timebox()` from `@effectionx/timebox` returns `Operation<Timeboxed<T>>` — a
discriminated union, not a thrown error. The factory checks `.timeout` and
raises explicitly:

```typescript
// src/modifiers/timeout.ts
import { timebox } from "@effectionx/timebox";
import type { ModifierFactory } from "../modifiers.ts";

export const timeoutFactory: ModifierFactory = (params) =>
  (_args, next) => function* () {
    const ms = parseDuration(params ?? "30s");
    const result = yield* timebox(ms, () => next());
    if (result.timeout) {
      throw new Error(`eval block timed out after ${params ?? "30s"}`);
    }
    return result.value;
  }();

function parseDuration(s: string): number {
  if (s.endsWith("ms")) return parseInt(s, 10);
  if (s.endsWith("m"))  return parseInt(s, 10) * 60_000;
  if (s.endsWith("s"))  return parseInt(s, 10) * 1_000;
  return parseInt(s, 10);
}
```

---

## 8. Registration

New factories are registered via `registry.set()` in the same location as
the existing built-ins (`exec`, `silent`, `sample`). The `ModifierRegistry`,
`createModifierRegistry`, and `composeModifierChain` in `src/modifiers.ts`
are used unchanged — no new registration mechanism.

```typescript
registry.set("eval",    evalFactory);
registry.set("persist", persistFactory);
registry.set("timeout", timeoutFactory);
```

---

## 9. Durable replay

### 9.1 What is journaled

`evalFactory` wraps execution in `durableEval`. Journal entry shape:

```json
{ "type": "eval", "name": "eval:MyComponent:2", "language": "typescript" }

{ "status": "ok", "value": {
    "value": { "port": 4321, "config": { "debug": true } },
    "sourceHash": "sha256:abc123...",
    "bindingsHash": "sha256:def456..."
  }
}
```

`value.value` contains only the JSON-serializable subset of exports.

### 9.2 Staleness detection

Install `useCodeFreshnessGuard` from `@effectionx/durable-effects`:

```typescript
yield* useCodeFreshnessGuard((blockId) => {
  const block = blocksByName.get(blockId);
  if (!block) return undefined;
  return {
    source: transformBlock(block.content, blockId, []).code,
    bindings: serializeExports(env.values, block.imports),
  };
});
```

If source or bindings hash changed since the last run, `StaleInputError` is
raised before replay of that block begins.

### 9.3 Live references on replay (v1 limitation)

Non-serializable bindings are not restored on replay. A downstream block
depending on a missing live reference will see `undefined` and likely throw a
`ReferenceError` — correct v1 behavior; deferred to v2.

### 9.4 `persist` during replay

On replay, `durableEval` returns the stored result directly — the block's
generator body is never entered. `persist` is a transparent no-op: no
`evalScope.eval()` call is made, no resources are retained.

---

## 10. File locations

**New files:**

| File | Contents |
|---|---|
| `src/eval-transform.ts` | `transformBlock()`, `serializeExports()`, `isJson()`, `TransformResult` |
| `src/eval-context.ts` | `createEvalContext()`, `compileBlock()`, `EvalCtxKey`, `EvalContext` |
| `src/eval-env.ts` | `EvalEnv`, `EvalEnvCtx`, `EvalScopeCtx` (holds `EvalScope` from `@effectionx/scope-eval`) |
| `src/eval-handler.ts` | `evalFactory` |
| `src/modifiers/persist.ts` | `persistFactory` |
| `src/modifiers/timeout.ts` | `timeoutFactory`, `parseDuration()` |

**Updated files:**

| File | Change |
|---|---|
| `src/modifiers.ts` | Register 3 new factories (`eval`, `persist`, `timeout`); update `executable` detection to include `"eval"` |
| `src/run-document.ts` | Create `EvalContext`; set `EvalCtxKey` on root scope |
| `src/expand.ts` | Call `useEvalScope()` per-component; set `EvalScopeCtx` and `EvalEnvCtx` via `Context.with()` |
| `src/types.ts` | Add `blockId: string` to `CodeBlockContext` |

**New dependencies:**

```json
{
  "dependencies": {
    "@effectionx/scope-eval": "^0.1.2",
    "acorn": "^8.x",
    "magic-string": "^0.30.x"
  }
}
```

---

## 11. Tests

### Tier T1 — Source transform

| # | Test |
|---|---|
| T1 | `const` declaration → `env.x = x` appended after |
| T2 | `let` declaration → `env.x = x` appended after |
| T3 | `function` declaration → `env.f = f` appended after |
| T4 | `class` declaration → `env.C = C` appended after |
| T5 | Destructuring `const { a, b } = obj` → `env.a = a; env.b = b` |
| T6 | Nested declaration (inside `if`) → NOT exported |
| T7 | Free variable in `currentEnvKeys` → injected as `const { x } = env` preamble |
| T8 | Free variable NOT in `currentEnvKeys` → not injected |
| T9 | Block with no declarations → no env-writes, no error |
| T10 | Source map generated; maps to original source positions |
| T11 | `//# sourceURL=eval:${blockId}` appended |
| T12 | Top-level `yield` → mode `"generator"` |
| T13 | Top-level `await` → mode `"async"` |
| T14 | Neither → mode `"sync"` |
| T15 | `yield` inside nested function → does NOT set mode to `"generator"` |
| T16 | Both top-level `yield` and `await` → transform-time error with clear message |

### Tier T2 — VM context and GeneratorFunction

| # | Test |
|---|---|
| T17 | Compiled generator can `yield*` Effection globals (e.g. `sleep`) from sandbox |
| T18 | Value written to `env.x` inside block is readable on `env.values` by host |
| T19 | Live object reference survives in `env.values` without cloning |
| T20 | Block re-executed after code change — no `SyntaxError` from `const` re-declaration |
| T21 | Block that throws propagates error through Effection scope |
| T22 | Async-mode block bridges via `call()` — result in `env.values` |

### Tier T3 — Middleware factory conformance

| # | Test |
|---|---|
| T23 | `evalFactory` satisfies `ModifierFactory` type |
| T24 | `persistFactory` satisfies `ModifierFactory` type |
| T25 | `timeoutFactory` satisfies `ModifierFactory` type |
| T26 | All three compose correctly via `combine()` from `src/middleware.ts` |
| T27 | `useCodeBlock()` inside `evalFactory` returns correct `CodeBlockContext` including `blockId` |
| T28 | `EvalEnvCtx.expect()` returns the component's `EvalEnv` |
| T29 | `EvalScopeCtx.expect()` inside `persistFactory` returns an `EvalScope` (from `@effectionx/scope-eval`) |

### Tier T4 — `eval` factory and `durableEval` integration

| # | Test |
|---|---|
| T31 | Golden run — journal entry written with `sourceHash`, `bindingsHash`, serializable exports |
| T32 | Full replay — evaluator not called, `env.values` restored from journal |
| T33 | Partial replay — replayed block restores env, subsequent block runs live |
| T34 | Divergence — mismatched block name in journal → `DivergenceError` |
| T35 | Error in block — propagated, journal records `Close(err)` |
| T36 | Serializable binding — present in journal result |
| T37 | Non-serializable binding — absent from journal, present in `env.values` during live run |

### Tier T5 — Binding environment

| # | Test |
|---|---|
| T38 | Block 2 reads binding exported by Block 1 via env preamble |
| T39 | Block 3 shadowing Block 1's binding — downstream blocks see Block 3's value |
| T40 | Empty block — no exports, no error |
| T41 | Block referencing undeclared binding not in env — `ReferenceError` with name in message |
| T42 | Syntax error in block — parse-time error before execution |

### Tier T6 — `persist` modifier

| # | Test |
|---|---|
| T43 | Resource spawned without `persist` — torn down after block's generator returns |
| T44 | Resource spawned with `persist eval` — still alive when next block executes |
| T45 | Resource spawned with `persist eval` — torn down when component eval-scope exits |
| T46 | `persist` on replay — no-op; `evalScope.eval()` not called, no resources retained |
| T47 | `evalScope.eval()` returns `Result<T>`; `unbox()` extracts the `CodeBlockResult` |
| T48 | `evalScope.eval()` error result — `unbox()` rethrows, error propagates through scope |

### Tier T7 — `timeout` modifier

| # | Test |
|---|---|
| T49 | Block completing before timeout — `timebox` returns `{ timeout: false, value }`, factory returns `value` |
| T50 | Block exceeding timeout — `timebox` returns `{ timeout: true }`, factory throws with duration in message |
| T51 | `timeout=500ms` → `parseDuration` returns 500 |
| T52 | `timeout=30s` → `parseDuration` returns 30 000 |
| T53 | `timeout=2m` → `parseDuration` returns 120 000 |

### Tier T8 — Staleness detection

| # | Test |
|---|---|
| T56 | Source unchanged, bindings unchanged — replay proceeds |
| T57 | Source changed — `StaleInputError` mentioning source |
| T58 | Input bindings changed — `StaleInputError` mentioning bindings |
| T59 | Non-eval events pass through code freshness guard unchanged |
| T60 | Unknown block name in `getCellSource` — guard passes through |

### Tier T10 — eval-scope hierarchy

| # | Test |
|---|---|
| T61 | Child component's eval-scope is a child of parent component's scope |
| T62 | Child eval-scope exits before parent's — parent resources unaffected |

### Tier T11 — End-to-end

| # | Test |
|---|---|
| T63 | Document with `eval` block — golden run, journal records eval entry, no rendered output |
| T64 | Document with `eval` block — full replay, evaluator not called, output identical |
| T65 | `silent eval` — block evaluates, result journaled, output empty |
| T66 | `persist eval` followed by `eval` — second block reads live resource from first |
| T67 | `timeout=1s eval` — block exceeds limit, `timebox` returns `{ timeout: true }`, factory throws |
| T68 | Source changed between runs — staleness guard halts replay, block re-executes |
| T69 | `eval` and `exec` blocks in same component — independent; `eval` has env, `exec` has stdout |

---

## 12. Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | All new modifiers are `ModifierFactory` | DEC-006: factory captures params in closure; context on scope; signature `Middleware<[], CodeBlockWorkflow>` aligns with Effection v4.1 |
| 2 | `EvalEnvCtx` / `EvalScopeCtx` use `Context.with()` | DEC-006: same scoping pattern as `CodeBlockCtx.with()` in `composeModifierChain`; no context leaks between blocks or components || 3 | `useCodeBlock()` used inside `evalFactory` | Already exported from `src/modifiers.ts`; reuse over reimplementation |
| 4 | `ephemeral()` wraps every Operation yield inside a factory | DEC-001: explicit bridge between `Workflow<T>` (yields `DurableEffect`) and `Operation<T>` (yields `Effect`); the boundary is a feature |
| 5 | One VM context per document run | Context creation is expensive; safe to share because blocks execute sequentially |
| 6 | `const`/`let` inside generator function body | Avoids `SyntaxError` on re-execution; each call gets its own activation frame |
| 7 | Mode auto-detected from AST at transform time | Execution mode is expressed by block syntax; modifier chain is for behavioral/cross-cutting concerns only |
| 8 | Non-serializable bindings silently omitted in v1 | Surfaces missing dependencies as `ReferenceError` on replay — clear failure; reconstruction deferred to v2 |
| 9 | `persist` uses `evalScope.eval()` from `@effectionx/scope-eval` | `evalScope.eval()` runs the operation in the persistent scope and retains resources; `unbox()` extracts the result or rethrows — no custom scope plumbing needed |
| 10 | `timeout` uses `timebox()` from `@effectionx/timebox` | `timebox()` returns `Timeboxed<T>` (discriminated union); factory checks `.timeout` and throws — no manual `race()` + `sleep()` |
| 11 | `eval` produces no rendered output | Eval blocks are binding and side-effect producers, not content producers |
| 12 | `blockId` added to `CodeBlockContext` | Required for `durableEval` naming and `//# sourceURL=eval:${blockId}` annotation |
| 13 | acorn + magic-string only | Minimal footprint; no Babel, no SWC, no esbuild |
| 14 | `buildCommand` in `src/modifiers.ts` untouched | `eval` compiles and runs directly — no command construction needed |
| 15 | `EvalScopeCtx` holds `EvalScope`, not raw `Scope` | `EvalScope.eval()` is the correct API for running operations while retaining resources; `Scope` has no such method |
