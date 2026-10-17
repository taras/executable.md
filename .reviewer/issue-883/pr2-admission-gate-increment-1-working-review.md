# Working-tree check: admission gate increment 1

Subsequently committed byte-identically and accepted:
[PASS at 14ebf82d](pr2-admission-gate-planner-review-14ebf82d.md).
The observations below preserve the earlier working-tree state.

No implementation blocker found within this increment's stated scope. This is
a working-tree check, not a feedback-commit PASS. In
`.claude/worktrees/issue-883-pr2`, branch `agent/issue-883-pr2`, HEAD remains
`01abab2763a7ef95d6bcfb67582df161f80918a5`. application.ts and the controls
test are modified; sidekick/gate.ts remains untracked. Nothing is staged.

The reduction now delegates frozen-position and empty-draft refusal to the
shared submittable predicate, preserving the existing refusal sentences.
Draft edits raise the draft revision and establish human takeover; a Sidekick
fill raises that same revision without establishing takeover. Explicit
instruction clears takeover separately. Admission with a reservation preserves
a newer draft revision. Initial state and location reconstruction initialize
the process-local fields without changing the location format.

The six added rows cover this pure state/decision behavior. They do not claim
live root integration: admissible/stillAdmissible have no production caller
yet, and program.ts still calls admitted(state) without a reservation. The
nonblocking input loop, exact-entry completion, real reservation and recovery
paths belong to the next increments. R2 cases 3/4 remain incomplete. Remaining
section 3 guide/bootstrap assets, reads and response-profile wiring also remain
required under the accepted main plan, even if delivered as a later slice.

Focused commands run against this working tree:

```sh
deno task test packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-route.test.ts
deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-output.test.ts
```

Results: 28 tests/111 steps and 11/57, respectively; total 39 tests, 168 steps,
zero failures. No full CLI suite or CI result was needed or inspected.

Reviewed file SHA-256 values:

| File beneath packages/cli | SHA-256 |
| --- | --- |
| src/repl/sidekick/gate.ts | 12fdfbe371a599009b763523fdd467d4a4da34b45c5774b1e36eaab35bf9964f |
| src/repl/application.ts | 0742eeaccd0d9cb822ece2e874fcf039c75146547290d7c5b7571cf4c5b4ecd7 |
| tests/repl-sidekick-controls.test.ts | 2e40ef25a0d6b810e03ded16f200790e482284a033119f8298d3b6473f8b337a |

Next Implementor action: commit the three increment files promptly and return
the exact SHA/parent and focused commands/results. The full background CLI
suite is not a feedback prerequisite. Formal review remains against that
stable revision; the accepted Core amendment stays PASS at 01abab27. No
production code changed in this review and no GitHub write is authorized.
