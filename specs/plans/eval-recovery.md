# Plan: Recover Eval System from commit `baa6035`

**Status:** In progress
**PR:** TBD
**Prerequisite for:** `specs/plans/daemon-modifier.md`

---

## Background

The complete eval system (3,091 lines, 24 files) was implemented on a
feature branch (`feat/generator-eval-blocks`) and merged via PR #8 into
`refactor/modifier-middleware-alignment`. However, that branch had already
been merged to main via PR #7 *before* PR #8 was created. The eval code
was never merged to main. The branch was deleted during cleanup. The
commits are reachable via `git show baa6035:<path>` but not from any branch.

This plan recovers the eval system onto main as a standalone PR. The daemon
modifier (Phase 2) will be a separate PR on top.

---

## Step 1: Install new dependencies

Add to `package.json`:

```
@effectionx/converge: ^0.1.3
@effectionx/scope-eval: ^0.1.2
@effectionx/timebox: ^0.4.2
acorn: ^8.16.0
magic-string: ^0.30.21
```

---

## Step 2: Restore eval source files

Recover via `git show baa6035:<path>`:

| File | Lines | Purpose |
|---|---|---|
| `src/eval-transform.ts` | 409 | Acorn-based source transform, mode detection, free variable collection, `serializeExports` |
| `src/eval-context.ts` | 104 | VM context (`createEvalContext`), block compiler (`compileBlock`), `EvalCtxKey` |
| `src/eval-env.ts` | 58 | `EvalEnv`, `EvalEnvCtx`, `EvalScopeCtx`, `PersistFlagCtx` context definitions |
| `src/eval-handler.ts` | 103 | `evalFactory` — terminal modifier using `durableEval` for journaling |
| `src/modifiers/persist.ts` | 44 | `persistFactory` — context flag pattern for resource lifetime extension |
| `src/modifiers/timeout.ts` | 66 | `timeoutFactory` + `parseDuration` — timebox wrapping modifier |

---

## Step 3: Apply diffs to existing files

Changes from `baa6035` applied to current main:

- **`src/types.ts`** — add `blockId: string` to `CodeBlockContext`
- **`src/expand.ts`** — add `blockId` generation:
  `` `eval:${parentMeta["componentName"] ?? "root"}:${result.length}` ``
- **`src/run-document.ts`** — create EvalContext + EvalScope (before
  `durableRun`), register `eval`/`persist`/`timeout` in modifier registry,
  wrap expansion in `EvalEnvCtx.with()`
- **`mod.ts`** — export eval system types and functions

---

## Step 4: Restore eval test files

| File | Lines | Spec tier |
|---|---|---|
| `tests/eval-transform.test.ts` | 185 | G (Source transform) |
| `tests/eval-context.test.ts` | 135 | H (VM context) |
| `tests/eval-bindings.test.ts` | 133 | K (Binding env) |
| `tests/eval-durable.test.ts` | 173 | J (eval + durableEval) |
| `tests/eval-middleware.test.ts` | 79 | I (Middleware conformance) |
| `tests/eval-persist.test.ts` | 179 | L (Persist modifier) |
| `tests/eval-scope.test.ts` | 83 | O (Eval scope hierarchy) |
| `tests/eval-staleness.test.ts` | 176 | N (Staleness) |
| `tests/eval-timeout.test.ts` | 98 | M (Timeout) |

---

## Step 5: Update smoke test

Restore updated `smoke-test/README.md` from `baa6035` with eval, persist,
and timeout sections.

---

## Step 6: Adaptation check — `when` vs `converge`

The `eval-context.ts` from `baa6035` imports `when` from
`@effectionx/converge`. Verify whether the published
`@effectionx/converge@0.1.3` exports `when`, `converge`, or both. Adapt
the import if the export name changed.

---

## Step 7: Verify

1. `npm run lint` — 0 warnings, 0 errors
2. `npm run typecheck` — clean
3. `npm test` — ~221 tests passing (151 existing + ~70 eval)

---

## Step 8: Ship

1. Create branch `feat/eval-system`
2. Commit with descriptive message
3. Push and create PR
4. Merge to main

---

## Risk areas

1. **`when` vs `converge` naming** — `@effectionx/converge` may have
   renamed the export between versions
2. **`durableEval` API compatibility** — must match what `eval-handler.ts`
   expects from installed `@effectionx/durable-effects`
3. **`@effectionx/timebox` not currently installed** — needed by
   `timeout.ts`
4. **`node:vm` + `--experimental-strip-types`** — the test runner uses
   this flag; verify `node:vm` works correctly with it

---

## Files inventory

### New files (recovered from `baa6035`):

**Source:**
- `src/eval-transform.ts`
- `src/eval-context.ts`
- `src/eval-env.ts`
- `src/eval-handler.ts`
- `src/modifiers/persist.ts`
- `src/modifiers/timeout.ts`

**Tests:**
- `tests/eval-transform.test.ts`
- `tests/eval-context.test.ts`
- `tests/eval-bindings.test.ts`
- `tests/eval-durable.test.ts`
- `tests/eval-middleware.test.ts`
- `tests/eval-persist.test.ts`
- `tests/eval-scope.test.ts`
- `tests/eval-staleness.test.ts`
- `tests/eval-timeout.test.ts`

### Modified files:

- `package.json` (5 new dependencies)
- `src/types.ts` (+1 line: blockId)
- `src/expand.ts` (+1 line: blockId generation)
- `src/run-document.ts` (+70 lines: eval wiring)
- `mod.ts` (+21 lines: eval exports)
- `smoke-test/README.md` (eval sections)
