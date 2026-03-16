# Spec/Implementation Consistency Report

Date: 2026-03-16
Scope: `specs/`, `durable-streams/specs/`, `durable-effects/specs/`

## Method

- Extracted and reviewed every markdown bullet in spec folders (`454` total).
- Split bullets into:
  - **Normative** (behavioral/contract requirements): `201`
  - **Non-normative** (decision log/history/context): `253`
- Cross-referenced normative bullets to implementation (`core/src`, `durable-streams`, `durable-effects`) and tests (`core/tests`, `durable-streams/tests`, `durable-effects/tests`).
- Reported only confirmed discrepancies (spec expectation and current code both explicitly observable).

## Bullet Inventory

| File | Bullet count | Classification | Status |
|---|---:|---|---|
| `specs/executable-mdx-spec.md` | 48 | Normative | No material contract drift found |
| `durable-streams/specs/protocol-specification.md` | 46 | Normative | Minor/major drift found |
| `durable-streams/specs/effection-integration.md` | 41 | Normative (design + implementation notes) | Internal drift found |
| `durable-streams/specs/durable-streams.md` | 35 | Normative-adjacent (integration guidance) | Generally aligned |
| `durable-effects/specs/effect-types.md` | 31 | Normative | Multiple drift items found |
| `durable-streams/specs/DECISIONS.md` | 250 | Non-normative decision log | Reviewed, excluded from pass/fail |
| `specs/decisions.md` | 3 | Non-normative decision log | Reviewed, excluded from pass/fail |

## Discrepancies

### D-001: Divergence is recoverable in implementation but fatal in protocol spec

- **Spec:** `DivergenceError` is not recoverable and runtime must halt.
  - `durable-streams/specs/protocol-specification.md:537`
- **Implementation:** divergence policy can choose `run-live`, disabling replay and continuing execution.
  - `durable-streams/effect.ts:124`
  - `durable-streams/effect.ts:125`
  - `durable-streams/effect.ts:176`
- **Severity:** major
- **Impact:** protocol consumers expecting strict replay-halting semantics can observe forward execution after mismatch.
- **Recommendation:** either (a) update protocol spec to describe policy-based divergence as an extension, or (b) gate `run-live` behind explicit non-default compatibility mode in spec + code docs.

### D-002: Offset model mismatch (integer offsets in spec vs opaque string offsets in implementation)

- **Spec:** offsets are monotonically increasing integers from 0.
  - `durable-streams/specs/protocol-specification.md:802`
- **Implementation:** offset is treated as opaque string (`lastOffset: string`, `offset: "-1"` for reads), matching Durable Streams protocol headers.
  - `durable-streams/http-stream.ts:57`
  - `durable-streams/http-stream.ts:242`
  - `durable-streams/http-stream.ts:248`
- **Severity:** major (documentation-contract mismatch)
- **Impact:** external implementers may build integer-index assumptions that do not hold for HTTP backend.
- **Recommendation:** align protocol spec wording to opaque monotonic offsets for this project, or explicitly split "logical index" from transport offset token.

### D-003: `durableFetch` description includes body-derived metadata contrary to effect spec

- **Spec:** request body is not in description.
  - `durable-effects/specs/effect-types.md:451`
- **Implementation:** includes `bodyHash: len:<n>` in effect description when request body exists.
  - `durable-effects/durable-fetch.ts:79`
- **Severity:** major
- **Impact:** replay identity metadata differs from spec; may change guard/diagnostic behavior and journal shape expectations.
- **Recommendation:** decide one of:
  1. Update effect spec to allow body-derived metadata (without raw body), or
  2. Remove `bodyHash` from description and keep body checks in result/guards only.

### D-004: `durableExec` env metadata shape differs from effect spec

- **Spec example:** description includes full `env` map.
  - `durable-effects/specs/effect-types.md:231`
- **Implementation:** persists only sorted env key names as `envKeys` (values redacted).
  - `durable-effects/durable-exec.ts:54`
- **Severity:** medium
- **Impact:** journal schema and diagnostics differ from documented shape; better secret hygiene, but undocumented.
- **Recommendation:** update effect spec to codify secret-safe metadata policy (`envKeys`) and clarify tradeoff.

### D-005: Runtime timeout semantics are specified but not fully implemented in Node runtime

- **Spec:** runtime handles timeout for exec/fetch operations in interface/notes.
  - `durable-effects/specs/effect-types.md:59`
  - `durable-effects/specs/effect-types.md:77`
  - `durable-effects/specs/effect-types.md:96`
- **Implementation:** node runtime documents timeout as currently unsupported for `exec`; fetch path passes method/headers/body and ignores timeout behavior beyond underlying defaults.
  - `durable-effects/node-runtime.ts:38`
  - `durable-effects/node-runtime.ts:116`
- **Severity:** major
- **Impact:** timeout-dependent workflows may not fail/cancel per documented contract.
- **Recommendation:** implement explicit timeout handling in `nodeRuntime.exec` and `nodeRuntime.fetch`, or narrow spec claims to current behavior.

### D-006: Effect-level test matrix in spec is broader than current durable-effects test coverage

- **Spec test pattern:** every effect should include golden/full replay/partial replay/divergence/error propagation.
  - `durable-effects/specs/effect-types.md:156`
- **Implementation tests:** strong golden/full replay coverage exists, but `durable-effects/tests/operations.test.ts` does not include explicit per-effect partial-replay and divergence cases.
  - `durable-effects/tests/operations.test.ts:29`
  - `durable-effects/tests/operations.test.ts:73`
  - `durable-effects/tests/operations.test.ts:115`
- **Severity:** medium (coverage drift)
- **Impact:** regressions in effect-specific replay boundaries/divergence behavior may be caught only indirectly by durable-streams tests.
- **Recommendation:** add a compact per-effect replay matrix (at least one partial replay + one divergence assertion per effect type).

### D-007: `effection-integration.md` contains internally inconsistent combinator signatures

- **Spec text (older section):** `durableSpawn` returns `Operation<Task<T>>` and accepts `Workflow<T> | Operation<T>`.
  - `durable-streams/specs/effection-integration.md:777`
  - `durable-streams/specs/effection-integration.md:782`
- **Spec text (later section):** combinators now return `Workflow<T>`.
  - `durable-streams/specs/effection-integration.md:1035`
- **Implementation:** combinators return `Workflow<...>` and accept `() => Workflow<T>`.
  - `durable-streams/combinators.ts:168`
  - `durable-streams/combinators.ts:205`
  - `durable-streams/combinators.ts:255`
- **Severity:** medium
- **Impact:** reader confusion and integration mistakes from contradictory guidance in same spec document.
- **Recommendation:** prune superseded snippets and keep one canonical signature set.

## Areas Reviewed With No Material Drift

- Executable MDX scanner/modifier chain/expansion/core replay behavior in `specs/executable-mdx-spec.md` is consistent with current code and test naming coverage.
- Two-event event model (`yield` + `close`) and replay-index structure match implementation.
- Structured concurrency semantics (`durableAll`, `durableRace`, cancellation close recording) are covered and aligned at behavioral level.

## Priority Fix Order

1. D-001 (divergence recoverability contract)
2. D-002 (offset model mismatch)
3. D-005 (timeout contract vs runtime behavior)
4. D-003 (fetch description schema drift)
5. D-006 (effect test matrix gap)
6. D-007 (internal spec contradiction)
7. D-004 (exec env metadata schema drift)
