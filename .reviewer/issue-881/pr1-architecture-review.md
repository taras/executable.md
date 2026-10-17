# PR 1 architecture review — #885

**PASS** on `c7d54769d56661bef38cee8549b148f3bf87a904`.
The original colour, pane and drawer slice preserves the settled REPL ownership
and presentation boundaries. No architecture blockers remain.

## Reviewed boundary

Reviewed [PR #885](https://github.com/taras/executable.md/pull/885) against base
`4c0414be1010f69f11bff0d1d634623a5b08f886`, resolved on 2026-10-09.
It is the bottom of the #881 stack: #885 → #886 → #887. The latter two PRs
depend on this head; they are not dependencies of this slice or covered by this
verdict. The open-PR overlap check finds no other private REPL implementation
overlap.

The accepted contract is [pr1-handoff.md](pr1-handoff.md), including the approved
UI16/UI17 window adjustment. The reference remains the older corrected archive,
SHA-256 `86be64318121546f3208342edaf17f0a3aed35f3fde2766b523423e6c708c77b`.
Lifecycle observation, generated-source restructuring and History presentation
remain outside PR 1.

This head merges accepted PR 1 commit
`080b6ec80ca74e614789e8d2252857ac281df7e5` with the stated main base.
`git show --remerge-diff --format= c7d54769d56661bef38cee8549b148f3bf87a904`
is empty: the published integration introduces no manual merge changes.
The PR 1 layout, palette, classifier, reference fixture and three frozen focused
test files are byte-identical to the accepted revision. The private REPL changes
from main carry its `entries` route spelling and command-owned `Interrupt` key.

## Structural findings

The review traces the full patch and its consumers against the frozen ownership
rules:

- Token runs are detached, frozen strings and role names. They add no executable
  capability or identity. Classification is pure and stays in private REPL
  composition; JSON comes from serialized parsed values.
- Multiple text operations remain inside one existing keyed row element. They
  create no token nodes, bounds or pointer targets. Runs apply only when their
  concatenation matches the mounted row's text; measured width constrains the
  committed operations.
- The shared layout builder measures the drawer's rule and side inset before
  admission. The admitted rows alone reach reconciliation, drawing and targets.
  UI16/UI17 advance the existing measured window at 72×20 and retain their
  behavioral assertions.
- Freedom retains focus ownership. Semantic colours survive focus, selection
  keeps its independent surface, and typed activation still travels through the
  existing mounted ancestry. Styling creates no alternate input path.
- The renderer remains model-blind. This slice adds no listener, reader, task,
  clock, execution state, Journal record, persistence format or provider work.
  Success, failure, cancellation, replay and teardown retain their existing
  owners.

The architecture and REPL specification changes describe these delivered
boundaries. No new architecture decision or exception is needed.

## Focused evidence

Prepared an isolated detached worktree at the exact reviewed head with
`deno task setup`, then ran:

```sh
deno task test packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-forms.test.ts
# exit 0 — 28 tests / 105 steps
deno task test packages/cli/tests/repl-composition.test.ts
# exit 0 — 9 tests / 45 steps
git diff 4c0414be1010f69f11bff0d1d634623a5b08f886 c7d54769d56661bef38cee8549b148f3bf87a904 --check
# exit 0
```

Saved outputs: [frozen focused checks](evidence/pr885-architecture-focused.log)
and [composition checks](evidence/pr885-architecture-composition.log).
The isolated checkout remains clean after verification.

[Planner acceptance](pr1-planner-acceptance.md) supplies the accepted revision's
35-pair visual review, independent colour expectations, five restored mutation
controls and unchanged cold-read signatures. Those artifacts remain pinned to
`080b6ec8`; this review does not relabel them as new captures from the integrated
head. The code comparison and fresh focused checks establish integration
continuity. No CI was inspected and no GitHub review was posted.

## Continuity

PR 1 architecture review is complete at the exact SHA above. #881's remaining
lifecycle/source and History work belongs to the separate #886 and #887
contracts and reviews. This verdict does not close the full parity Story.
