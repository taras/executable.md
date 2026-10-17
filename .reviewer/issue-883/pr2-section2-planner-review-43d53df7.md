# PR 2, section 2 correction review

PASS at `43d53df757bcbec6fb4af1e5060313f835e72ad2`.
Parent: `ec118e26d0fe44ec7d9e6e9aae90f4910be3f321`.
Core foundation: `79d404d04d02c3840892473b6f1b2cf540f3edd1`.

This closes all three findings in the
[previous section review](pr2-section2-planner-review.md). It accepts the
paired-history section at this exact revision. The remaining CLI work and its
integration evidence remain part of the planned PR 2 feedback threshold.

## Findings resolved

The upgrade reads one acknowledged snapshot, parses it for validity and the
retained stream, fingerprints that snapshot and copies its original text in one
append. Parsed events no longer supply the migration encoding. The held-append
wait and synchronous writer redirection remain intact.

Opening validates the copied prefix at the declared record boundary against its
count, byte count and digest. Later entry records remain permitted. An older
file beside a pair without a declared origin is refused; the retained origin
check still refuses a changed original.

Record parsing constructs typed values from checked members, checks optional
members and nested serialized errors, requires control arguments, rejects
undeclared members and validates embedded canonical events. Publication checking
now rejects later owner or ready records across the whole file. These changes
resolve the malformed-error and conflicting-owner findings without exposing
retained record text in parse diagnostics.

The separate repository module, placement of `movableWriter` in `journal.ts`
and required legacy/paired discriminator remain accepted.

## Focused evidence

Independently run from `.claude/worktrees/issue-883-pr2` at the reviewed commit:

```sh
deno test --allow-all --frozen --config deno.json /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-section2-storage.probe.ts
deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-admission.test.ts
deno task test packages/cli/tests/repl-history.test.ts
```

- The archived probe passes unchanged: one test, six steps. All five former
  failures pass, as does the later-append control.
- Storage plus execution, entries and admission pass: 31 tests, 125 steps.
  The storage tier contains 26 passing cases, including the correction rows.
- History passes: six tests, 24 steps.

The Implementor reports Node and Bun storage passes, lint and typecheck passes,
and targeted controls. The independent review evidence above uses Deno. No CI
was inspected. The implementation worktree remains clean at the exact reviewed
SHA; this review changes only reviewer artifacts.

## Continuity

Section 2 has no remaining review blocker. Continue `sidekick/model.ts`, root
wiring in `program.ts`, R2's six interruption boundaries and the remaining
planned sections. Root admission gating, the actual running entry task, route
preservation and provider ordering still need their planned integration
evidence. Full PR 2 acceptance retains the frozen R1–R8 and 36-frame threshold;
this section verdict does not change it.
