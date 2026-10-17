# PR #886 — fatal precedence through expansion middleware: implementation handback

**Corrected at `ecca5c459b77bed653bcdeab5efd4f9ab656bb2e`.** Not pushed; #886,
#887 and #889 are untouched.

## Base

| | |
| --- | --- |
| Feedback commit | `ecca5c459b77bed653bcdeab5efd4f9ab656bb2e` (signed, `%G?` = `G`) |
| Parent / exact base | `a85c36cb2edc184055b9aa3e270ba1d70b20670f` |
| Main | `160e354e47f6fbeb1c792e6799c1fe26b2f155fc` |
| Branch | `agent/issue-881-pr2-fatal`, worktree `.claude/worktrees/pr2-fatal` |

Changed files, 176 insertions / 2 deletions:

- `packages/core/src/component-expansion.ts` — +39/-2
- `packages/core/tests/component-expansion.test.ts` — +139

The lifecycle-suite cleanup at `a85c36cb` is preserved untouched.

## Reproduced first

The Planner's reproducer, adapted to this checkout's relative imports as
`packages/core/tests/zz-fatal-probe.test.ts` (temporary; deleted before the
commit). First failing output, verbatim:

```
{"bodyFails":false,"thrown":{"name":"DurablePersistenceError",…},"fatalPreserved":true}
{"bodyFails":true,"thrown":{"name":"Error","message":"ordinary body failure"},"fatalPreserved":false}
Expected: [DurablePersistenceError: Failed to persist durable yield event]
Received: undefined
FAILED | 0 passed (1 step) | 1 failed (1 step)
```

The positive control (`bodyFails=false`) already preserved the persistence
failure; only the competition lost it.

## The correction

`observeExpansion` captured `chainFailure`, then reported and threw
`settlement.raised` without consulting it. Both halves can fail — the body
raises, and middleware's own unwind raises something else on the way out — and
the canonical half was winning unconditionally.

A new private `selectedFailure(canonical, laterFailed, later)` sits beside
`observeExpansion` and reconciles after the whole dispatch has unwound, in the
order `rankBoundFailure` in `expand.ts` already ranks bound failures:

1. `durabilityFailure(canonical) ?? durabilityFailure(later)`
2. else `filesFatalFailure(canonical) ?? filesFatalFailure(later)`
3. else `canonical`

`??` on the canonical side first keeps the existing preference for the earlier
failure within each fatal kind. `laterFailed` gates the middleware side, so the
distinction between "no failure" and "raised `undefined`" survives — a raised
non-Error value still reaches `reported(String(value))` unchanged.

The raised branch now computes `selected` once and uses the same value for the
authoritative `throw` and for the single `Err(reported(selected))` terminal
observation, so the report cannot name a different failure from the one that
escaped.

Deliberately scoped: the `"absent"` (refusal) branch and the `chainFailed`
success branch are unchanged — rule 4 ("canonical succeeded, middleware failure
still fails the expansion") already held there, and the regression keeps it as
the positive control rather than rewriting the path. No shared helper with
`expand.ts`: the two reach the decision with different shapes, and a common
helper would be a third boundary to keep in step. No resource owner, public API,
dependency or persistence change.

One non-behavioral repair in the same file: the first draft inserted the new
helper between `observeExpansion`'s docstring and `observeExpansion`, orphaning
the docstring onto the helper. The helper and its own docstring now precede it.

## Regressions

Four cases in `packages/core/tests/component-expansion.test.ts`, all driven
through the suite's existing `watch()` helper — the public
`Component.around({ expand })` chain and the real `expandSegments` boundary, not
a direct call to `observeExpansion`:

| Case | Asserts |
| --- | --- |
| `CX3: durability raised while middleware unwinds outranks the body's failure` | `durabilityFailure(failure)` is the `DurablePersistenceError` **by identity**; the terminal report is named/messaged for it, carries its explanation, and is detached |
| `CX3: a Files fatal raised while middleware unwinds outranks the body's failure` | `filesFatalFailure(failure)` is the `FilesProviderUnavailableError` by identity; same report assertions |
| `CX3: a later ordinary middleware failure does not displace the body's` | the body's failure propagates and is reported; the unwind's message appears nowhere |
| `CX3: a body that succeeded still fails when middleware's unwind raises` | positive control: no competition, same failure is the outcome, nothing rendered |

Detachment is asserted on the report, not merely on the thrown failure:
`report !== raised`, `Object.isFrozen(report)`, and — the branding check —
`durabilityFailure(report)` / `filesFatalFailure(report)` are both `undefined`.
The report conveys the selected name, message and explanatory cause while
recognizing as neither a durability nor a Files fatal failure, so catching an
observation cannot be mistaken for catching the failure.

A small local `reportedBy(watched)` reads the terminal `complete` phase and
throws if the element did not complete with a failure, rather than casting.

Existing publication, rescue and once-only checks are untouched. No permutation
matrix was added.

## Mutation control

Restored the pre-fix selection in place —
`const selected = selectedFailure(settlement.raised, chainFailed, chainFailure);`
→ `const selected = settlement.raised;` — and re-ran the suite:

```
CX3: durability raised while middleware unwinds outranks the body's failure ... FAILED
  Expected: [DurablePersistenceError: Failed to persist durable yield event]
  Received: undefined
CX3: a Files fatal raised while middleware unwinds outranks the body's failure ... FAILED
  Expected: [FilesProviderUnavailableError: Files provider is not installed]
  Received: undefined
CX3: a later ordinary middleware failure does not displace the body's ... ok
CX3: a body that succeeded still fails when middleware's unwind raises ... ok
FAILED | 0 passed (26 steps) | 1 failed (2 steps)
```

Both competition cases break and reproduce the original symptom exactly
(`Received: undefined`). The ordinary-precedence case and the positive control
stay green under the mutation, which is what shows they are not restating the
fix.

Restoration verified by digest, not by eye — `shasum -a 256` of
`component-expansion.ts` before the mutation and after the restore:
`2aed06e7108ea104ffd6d8ea87b6c258a8e83ee6a1a89e7d325051f1d1b313bb`, `OK`. All
focused commands below were run after that restoration.

## Focused commands

| Command | Result |
| --- | --- |
| `deno task test packages/core/tests/component-expansion.test.ts` | `ok \| 1 passed (28 steps) \| 0 failed` |
| frozen Core command (11 suites) | `ok \| 53 passed (418 steps) \| 0 failed` |
| `deno task test packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-agent-execution.test.ts` | `ok \| 14 passed (52 steps) \| 0 failed` |
| `deno check` on both changed files | clean |
| `pnpm lint` | exit 0; no diagnostic on either changed file |
| `git diff --check 160e354e HEAD` | clean |

No full corpus, gallery rerun or CI wait, per the handoff.

## Next action

Return the corrected execution boundary for Architect review and Planner
accept-or-request-changes. Stopped before pushing, updating PRs, merging or
touching the dependent stack.

## Pushed and restacked (authorized follow-up)

The correction is on #886, and the two dependent PRs were rebased onto it so
they carry both pr2 commits rather than branching below them.

| PR | Branch | Was | Now | Push |
| --- | --- | --- | --- | --- |
| #886 | `agent/issue-881-pr2` | `a85c36cb` | `ecca5c45` | fast-forward |
| #887 | `agent/issue-881-pr3` | `ad4a0d4d` | `a9905f3c` | forced, lease held |
| #889 | `agent/issue-881-pr4` | `db4896fc` | `f3024b6b` | forced, lease held |

`origin/agent/issue-881-pr3` had branched from `3815aef4` — the pr2 tip *before*
the lint fix `a85c36cb` — so neither #887 nor #889 had ever carried it. Both
now do, which is what the restack was for.

Rebased in a dedicated `.claude/worktrees/restack-881` detached checkout, so no
other worktree's branch was moved: `--onto ecca5c45 3815aef4` for pr3's seven
commits, then `--onto a9905f3c ad4a0d4d8` for pr4's two. No conflicts —
`a85c36cb` touches only `repl-lifecycle.test.ts` and `ecca5c45` only
`packages/core/`, and neither pr3 nor pr4 touches either path.

Verified rather than assumed:

- All nine replayed commits are signed (`%G?` = `G` for each).
- `git diff ad4a0d4d a9905f3c` and `git diff db4896fc f3024b6b` are each
  *exactly* `git diff 3815aef4 ecca5c45` — 3 files, +301/-143. The two
  dependent slices' own content is byte-identical to what was reviewed; only
  the inherited base changed.
- On the restacked top of the stack (`f3024b6b`), the three slices' focused
  suites together: `ok | 81 passed (261 steps) | 0 failed`
  (`component-expansion`, `repl-lifecycle`, `repl-source-reading`,
  `repl-presentation-style`, `repl-journey`, `repl-entries`,
  `repl-layout-admission`).
- GitHub agrees: #886 `ecca5c45` → `main`, #887 `a9905f3c` → pr2, #889
  `f3024b6b` → pr3, all three MERGEABLE, diffs 40/20/8 files with no
  cross-contamination.

Left stale on purpose: the local branches in the `issue-881-pr2`, `-pr3` and
`-pr4` worktrees still point at `acadbbdb`, `05ba70d5` and `db4896fc`. Git
refuses to move a branch checked out elsewhere, and those are other worktrees'
to reset. The PRs track the remote, which is correct.

## #886 merged; the stack moved onto main

You squash-merged #886 at 10:01:53Z as `9fe494d7` and the branch was deleted, so
GitHub retargeted #887's base to `main` and it went CONFLICTING — its history
still carried the pr2 commits that main now holds squashed. `git diff ecca5c45
9fe494d7` is empty, so the squash is content-identical and the replay is safe.

Rebased both remaining slices onto the new main, dropping the absorbed commits:

| PR | Branch | Base | Head | Own commits |
| --- | --- | --- | --- | --- |
| #887 | `agent/issue-881-pr3` | `main` (`9fe494d7`) | `3edcee39` | 8 |
| #889 | `agent/issue-881-pr4` | `agent/issue-881-pr3` | `6749fa8c` | 2 |

`--onto origin/main ecca5c45` for #887's eight commits, then
`--onto 3edcee39 ff7a2f8d` for #889's two. Both clean. Every replayed commit
signed. `git diff` between each old and new tip is **empty** — identical trees,
so nothing of either slice's content changed when its base did.

Both now MERGEABLE: #887 20 files / +3048/-236 against main, #889 8 files /
+923/-69 against #887.

## #887's test-node failure, found and fixed

All ten `test-node (n/10)` shards failed on #887, and `test-node` is a `green`
dependency. Not the rebase, and not a test: the **Typecheck** step, which runs
before the tests and is identical on every shard.

```
packages/cli/tests/repl-history.test.ts(174,22): error TS2550: Property 'toSorted' does not exist on type 'number[]'
packages/cli/tests/repl-history.test.ts(426,33): error TS2550: Property 'toSorted' does not exist on type 'string[]'
packages/cli/tests/repl-history.test.ts(593,45): error TS2339: Property 'toSorted' does not exist on type 'readonly number[]'
Process completed with exit code 2.
```

`tsconfig.node.json` pins `"lib": ["ES2022"]`; `toSorted` is ES2023. The three
calls are PR 3's own, in a file it creates. Reproduced locally in under a
minute with `pnpm exec tsc --project tsconfig.node.json --noEmit` — the same
three errors — rather than from CI logs.

Three gates said yes and only the CI-only one said no: `deno check`,
`deno task test` and `pnpm lint` all pass, and oxlint's
`unicorn(no-array-sort)` actively *recommends* `toSorted` over mutating
`sort()`. That is why it reached CI at all.

Fixed in `ff7a2f8d` (now `7789b21f` after the main rebase): sort a copy. That
keeps what `toSorted` was chosen for — `group.ordinals` arrives `readonly`, and
nothing observes the order of the array sorted at either other site.
`Object.keys` already returns a fresh array, so that one sorts in place; oxlint
flagged my first attempt's spread there as redundant, and it was right. One
comment at the first site gives the reason, so the next reader does not restore
`toSorted`.

After the fix: `tsc --project tsconfig.node.json --noEmit` exit 0;
`repl-history.test.ts` `ok | 6 passed (24 steps) | 0 failed`; `deno check`
clean; `pnpm lint` exit 0. Re-run after the second edit, not just the first.
Three `no-array-sort` warnings remain and are the lib's cost, not a regression —
`pnpm lint` exits 0 with warnings, and main already carries others.
