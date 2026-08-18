# Implementation Handoff: #369 Slice 1

Repository: `taras/executable.md`
Issue: #369, "Evaluate Agent-generated XMD through a constrained allowlist" — slice 1
Feedback commit: `aaaf4c2` on `agent/issue-369-generated-xmd`
Base: `origin/main` at `1948bf039ef7edfeb82fdbbcaa4c6fedd978bf0c` (branched directly, no stack)
Worktree: `/private/tmp/xmd-369-impl`
PR: https://github.com/taras/executable.md/pull/497 — draft, based on `main`,
body written from `.github/pull_request_template.md`.

## What was delivered

Read-only generated-XMD observation admission through a trusted-host seam, with
no live Agent integration and no mutation proposal admission.

`@executablemd/core/host` now exports `evaluateGeneratedXmd(request)` together
with `pinnedFetch()`, `pinnedComponent()`, `GeneratedXmdError` and the request
types. A trusted host reaches it from a `DurablePreparation`, so it runs inside
the durable root — after retained-history admission and before any public
document policy or the root import — and what it performs is journaled.

Observable behavior, before → after:

- Before: nothing could run Agent-generated source. `specs/executable-mdx-spec.md`
  §6.18 stated "Generated XMD cannot use `<Fetch>`", and both the architecture
  inventory and `specs/workflow-workspace-spec.md` §14 recorded the evaluator as
  unbuilt.
- After: a host-supplied fragment is parsed and walked whole before its first
  effect; only the pinned identities the host admitted execute; one ordinary
  `generated_xmd` durable event records the admitted source, the retained roots,
  the selected root, the pinned identities the fragment named and the exact
  request policy, committing before the first observation; admitted observations
  run through their ordinary components and ordinary durable effects; and replay
  restores both without repeating either.

## Files changed

New:

- `packages/core/src/generated-xmd.ts` — the evaluator: request shape, fixed
  diagnostics, whole-fragment preflight, the closed import authority, the
  durable admission record and its parser, and the expansion.
- `packages/core/src/components/import-authority.ts` — `ImportAuthority`,
  `CanonicalImports`, `retain()`. #301's witness table, moved out of
  `components/bundle.ts` so both closed executions share one anti-forgery
  comparison.
- `packages/core/tests/generated-xmd.test.ts` — Tier GX, 46 steps.
- `packages/workflow/src/generated-observations.ts` — the internal slice-1
  workflow policy wrapper. Deliberately **not** exported from
  `packages/workflow/mod.ts`.
- `packages/workflow/tests/generated-observations.test.ts` — Tier WGX, 7 steps.

Modified:

- `packages/core/host.ts` — the new exports and a module-doc paragraph.
- `packages/core/src/components/bundle.ts` — `WorkflowImportAuthority` now
  composes `CanonicalImports`; its three diagnostics are byte-for-byte
  unchanged.
- `packages/core/src/expand.ts` — the `bundle` parameter is renamed `authority`
  and retyped `ImportAuthority`. Mechanical apart from the comment at the import
  site.
- `architecture.md` — "Agent authority and generated XMD" rewritten for what is
  built and the core-vs-host ownership split; the workflow-component-bundle and
  `<Fetch>` inventory rows updated; the "read-only workflow Agent / generated
  XMD" row split into a built observation-admission row and an unbuilt
  mutation-proposal row.
- `specs/workflow-workspace-spec.md` — §8.4 replaced (the `<Expand>` /
  `Agent.AddDir` wording is gone); §14 contract inventory split into a built
  observation row and an unbuilt mutation row.
- `specs/executable-mdx-spec.md` — §6.18's "Generated XMD cannot use `<Fetch>`"
  replaced with the pinned-identity-plus-exact-request rule; Tier FE gains a
  GX11–GX14 row; the module inventory gains `src/generated-xmd.ts` and
  `src/components/import-authority.ts`; the durable-effect table gains
  `generated_xmd`.

## Design decisions the reviewer should check

1. **The seam is `DurablePreparation`.** `evaluateGeneratedXmd` is a `Workflow`,
   so it is reachable from a host's `prepare` hook. Its non-durable work
   (preflight, expansion) crosses through `ephemeral()`; the durable effects
   *inside* the expansion still journal, exactly as they do inside
   `durableImportComponent`.
2. **Import resolution is closed, and the chain still runs.** Core's own
   `importComponent` provider installs at `min` on the fragment's own scope and
   answers only from the allowlist; the public chain composes around it and may
   observe or refuse, and its answer is verified against the witness at the call
   site. `componentDirs` is never consulted for a generated name.
3. **Each import mints a fresh copy.** `GeneratedImportAuthority.issue()` hands
   the chain `retain(pinned.definition)` rather than the table entry, so a
   handler that mutates one answer cannot reach the table or a later import.
4. **The generated fragment expands under a throwing error mode.** A printed
   error would leave every element after a refusal still running.
5. **Replay expands the *retained* source.** The admission record carries the
   source in its result value, and preflight runs again on what came back, so a
   continuation runs the fragment this run admitted. `input` is stored but never
   compared for divergence, which is why the source lives in the result.
6. **`pinnedFetch()` refuses an empty ceiling.** Admitting `<Fetch>` with no
   stated request would be an unbounded network read, which is a different
   decision.

## Frozen evidence matrix

Every criterion in the planner's matrix is covered:

| Criterion | Test |
| --- | --- |
| Trusted-host synthetic seam admits source without an Agent | GX1, GX2 |
| Complete-fragment preflight before first effect | GX3 (both orders), GX4b (nested content) |
| Only allowed pinned identities execute | GX7, GX8, GX10 |
| Identity substitution and same-name repository components fail closed | GX7, GX8, GX9 (synthetic / replacement / mutation) |
| Host-supplied Workspace roots cannot be widened or replaced | GX4 (`<Dir>`, `<Repository>`, `<Worktree>`, `<Agent.AddDir>`), WGX2, WGX3 |
| Mixed safe/unsafe fragments produce no partial effect | GX3, GX4b |
| Expressions, imports, eval, exec, native execution, unsupported components refused | GX4 table |
| Bounded Fetch only for the pinned identity and exact request | GX11, GX12 (nine mismatch classes), GX13, GX13b, WGX4–WGX6 |
| Filtered source, decision, results and identities retained through the secret gate | GX2, GX18 |
| Secret diagnostics retain no rejected material | GX6, GX19, GX20 |
| Interruption before commit retains no partial observation | GX17 |
| Completed replay restores admitted source/results without repeating observations | GX15, GX16 |

## Verification performed against `aaaf4c2`

```bash
deno task test packages/core/tests/generated-xmd.test.ts \
  packages/workflow/tests/generated-observations.test.ts \
  packages/core/tests/fetch-component.test.ts \
  packages/core/tests/workflow-component-bundle.test.ts
# ok | 21 passed (133 steps) | 0 failed   — run before GX13b was added

deno task test packages/core/tests/generated-xmd.test.ts
# ok | 6 passed (46 steps) | 0 failed     — run after GX13b was added

deno task test packages/workflow/tests/generated-observations.test.ts
# ok | 2 passed (7 steps) | 0 failed

deno task lint     # exit 0 (pre-existing scripts/ warnings only)
deno task check    # exit 0
deno task check:jsr  # Success Dry run complete
deno task fmt      # applied; oxfmt --check reports all files correctly formatted
```

`deno task test --changed=origin/main` — see the note below.

## Non-blocking observations (the Planner decides whether to track)

- A spread prop (`<C {...x} />`) is discarded by the scanner before segments
  exist, so it derives no prop and the evaluator never sees one. It is inert
  rather than refused. The plan listed spread among what preflight refuses; the
  construct cannot reach preflight, so the refusal table covers the expression
  props `ComponentElement.expressions` actually carries.
- `as` is refused rather than admitted. Nothing in an admitted fragment can read
  a binding, so one would be inert, and refusing it keeps an uncaptured non-2xx
  `<Fetch>` a failure rather than silent data. The matrix does not cover `as`
  either way.
- Text interpolation is refused by matching the same two shapes `interpolate()`
  and `interpolateEvalBindings()` consume, after protecting `\{` as expansion
  does. A generated fragment writing `{word}` in prose is refused; braces neither
  pass would read are left alone (GX5).

## Remaining work

- Slice 2: mutation-proposal admission under a separate pinned mutation
  allowlist.
- #302: the live Agent request/result loop that consumes this boundary.
- `<Agent.AddDir>`, ACP `additionalDirectories`, workflow-bundled Markdown
  component admission, and #496's provider-level no-tool hardening.
- CI on #497. The PR is based on `main`, so every job runs.

## Next action

Planner review of `aaaf4c2` (PR #497, draft) against the frozen acceptance
and evidence matrix. The PR stays draft until that verdict is `PASS`.
