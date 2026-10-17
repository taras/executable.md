# Planner review: guide examples at 9a9d2a04

PASS at `9a9d2a041e0dfb825c7f51ef0589e83616d5f86c`, parent
`c8c689e7adc4fc6783df1e30539d8da1bc760d96`, branch `agent/issue-883-pr2`.
HEAD matches, signature verifies G for tarasm@gmail.com, and the implementation
worktree is clean. The guide-example blocker is closed and the guide-assets
increment is accepted. The accepted admission stack and R2 cases 1/3/4 stay closed.

## Corrected examples and teaching

Effection and Lifetimes now distinguish the documentation display fence, the
response's passive capture fence and the future entry's executable fence. The
display uses five backticks, the passive capture uses four, and the entry's eval
fence uses three. The captured draft retains the executable fence without making
it executable response source. Both chapters explain the consequence of omitting
the passive layer.

Both examples are complete and use existing eval bindings. `sleep` and `resource`
are supplied by the standard imports documented in executable-mdx-spec.md §4.3
and installed by the existing eval compilers. No missing import, placeholder
operation, external service or provider supplies the examples' behavior.

The Lifetimes example acquires an actual Effection resource with owned cleanup
and observes its release in the next eval block. Its text now teaches block
completion and the existing persist modifier rather than claiming that returning
from an ordinary call releases the resource. That correction matches the
existing specification's block/persist lifetime contract; no architecture
decision or production change is introduced.

## Finite evidence

Three rows extract the examples from the shipped chapter files, evaluate them
through the actual Sidekick ceiling and live generated-root method, and pass the
resulting draft unchanged into the ordinary session submission path:

| Chapter | Observed result |
| --- | --- |
| Entries control | One literal draft fill; the entry prints `Hello, Ada!`. |
| Effection | One fill preserving the executable fence and `yield* sleep(1)`; the entry prints `started then resumed`. |
| Lifetimes | One fill preserving the resource program; the next block observes `acquired, used handle, released` before entry completion. |

The extractor captures and back-references the display fence length, so it
handles the real nested source rather than accidentally selecting an inner
fence. The chapter's promised output is produced by the prepared entry, not by
the request fixture. The sleep is the example's work, not a readiness assertion.
The existing admitted-index narrowing control remains green.

The Implementor reports that collapsing the Effection example's fence layers
fails that row alone with Core's refusal, leaving Entries and Lifetimes green.
This review did not mutate production or assets to repeat that control.

The [archived reviewer probe adapted to the new display fences](pr2-guide-examples-probe-9a9d2a04.test.ts)
also passes all three cases. Only its extraction changed: a back-referenced
opening fence replaces the fixed four-backtick match, and the source capture
group moves accordingly. Its real admission and one-fill assertions remain
unchanged. [Output](pr2-guide-examples-probe-9a9d2a04.log) is preserved.

## Independently rerun commands

All commands ran from `.claude/worktrees/issue-883-pr2` at the reviewed SHA.

| Command (`deno task test` with these files) | Result |
| --- | --- |
| packages/cli/tests/repl-journey.test.ts | 39 tests, 71 steps |
| packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-agent-execution.test.ts packages/cli/tests/repl-sidekick-controls.test.ts | 47 tests, 179 steps |
| packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-output.test.ts | 13 tests, 64 steps |
| packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts | 19 tests, 54 steps |
| scripts/tests/packaged-document.test.ts | 2 tests, 6 steps |

The four CLI commands total 118 tests/368 steps; packaging adds 2 tests/6 steps:
120 tests/374 steps, zero failures. Logs are beside this review as
`pr2-guide-examples-review-9a9d2a04-{journey,entries,storage,layout,packaged}.log`.

The separate reviewer probe passes one test/three steps:

```sh
deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-guide-examples-probe-9a9d2a04.test.ts
```

The previously accepted asset/index/packaging approach remains unchanged.
No fresh binary/npm build, full suite or CI result informs this verdict.

## Continuity and next action

Accepted base is 9a9d2a04. This review and planner-handoff.md record acceptance;
the guide-example correction prompt is complete. Continue section 3's remaining
SidekickRequests/read/profile/root wiring under the frozen plan: bind the real
guide, output, bindings, syntax and environment reads and the draft/admission
requests to the shared root.

The asset increment does not claim end-to-end guide feedback or first-turn
delivery. Complete remaining R3 and the planned R5 discovery/teaching evidence
with their production owners. Section 4/R2 cases 2/5/6 and section 5's flags,
terminal integration and 36-frame packet remain incomplete. PR 2 is still in
progress. No production edit, implementation commit, push, GitHub mutation or
memory compaction was performed by this review.
