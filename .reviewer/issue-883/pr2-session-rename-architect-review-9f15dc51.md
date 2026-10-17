# Architect review: session vocabulary rename

**PASS** — `9f15dc516ab8108efb3d4d19f970e32ffbe60000`.

This reviews #883 PR 2's mechanical rename, increment 1 of four, directly on
`b01bbe6c5a51a383d52a1d8ce25d384b6aefc3e2`. The reviewed branch is
`agent/issue-883-pr2` in `.claude/worktrees/issue-883-pr2`; HEAD is the requested
commit and the tree remains clean after verification.

## Boundary and evidence

The accepted [Architect handoff](pr2-session-vocabulary-architect-handoff.md)
and [frozen rename assignment](pr2-session-rename-implementor-handoff.md)
define this increment. The [Implementor handback](pr2-session-rename-implementor-handback.md)
reports RN1–RN5, compiler/JSR results and the assigned focused selections.
Architecture coverage builds on the full prior base reading and the complete
architecture/specification changes at this exact revision.

The source changes preserve the settled structural contracts:

- Core issues and consumes the same private, one-use request. Renaming the
  class, factory, owner and finish method adds no identity surface or authority.
  The private issuance, configuration sealing, live-owner check, duplicate
  settlement guard and exact Session registration retain their ordering.
- The delivery adapter reads sessionSetup and finish by their new literal names
  and calls them with the original receivers. The independently bundled Core
  fixture uses those same names. Foreign or rebuilt requests remain refused;
  raw Sessions and authentic configured uses keep their existing routing.
- ACP's new/existing values and details arm are transient names. The three
  readers of ACPX's sessionMaterialization marker still compare its stored
  pending value. No durable marker, key, route, path or digest input is changed.
- Native creation, first-turn acceptance, identity recording, reattachment,
  cancellation and handle-release paths retain their existing order. The
  workflow host commits the same identity association and retains its mismatch
  checks. The Git checkout-path functions and Plan/workflow key algorithms keep
  their inputs and results.
- REPL layout remains detached parent-child data. The structural and Answers
  renames preserve their checks, regions, scanner values and preflight ordering.
- recordSessionIdentity remains optional and layoutAllowed remains present, as
  the frozen rename increment requires. No activate implementation or tree
  validate method is introduced early.

A committed-tree search finds no retired placement term or named legacy surface
in owned text outside the explicitly excluded pinned snapshots and historical
review records. No compatibility alias is introduced. The Implementor's broader
two-way control also accounts for GitInvocationPlace, which is a different
published name and is outside the retired term.

Reviewer independently ran:

```text
deno task test packages/acp/tests/loaded-copy.test.ts packages/acp/tests/session-key.test.ts packages/core/tests/agent-session-setup.test.ts
```

Result: **3 passed, 24 steps, 0 failed**, exit 0. This exercises the actual
foreign-Core bridge, session-key lookup and setup ownership/refusal behavior.
Compiler, JSR and the other frozen focused results are reported by the
Implementor; they were not rerun for this architecture review. No full suite,
CI inspection, dependency installation or source mutation was performed.

## Non-blocking reference correction

`specs/acp-client-spec.md:164–176` renames the interface/type but still shows
fresh/established discriminants and complete(). It should show new/existing and
finish(), matching `packages/core/src/agent/session-setup.ts:57–66` and the prose
immediately beneath the specification example.

The exported types, runtime bridge and callers agree on the accepted contract;
this stale example introduces no alternate runtime route or accepted identity.
It is a reference correction, not a structural blocker or a reopening of the
architecture verdict. No production correction was made during review.

## Continuity

Architecture review of increment 1 is complete. Planner reviews the same SHA
against RN1–RN5 and supplies the exact base for increment 2, returned-tree
validation. Required custom-host recording and active provider configuration
remain later increments. R2 as a whole is not complete. Mounted section 5,
terminal R7/R8 and the 36-frame comparison remain separate. Nothing was pushed
or published to GitHub.
