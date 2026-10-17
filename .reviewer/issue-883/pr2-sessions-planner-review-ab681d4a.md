# Sessions review: PASS at ab681d4a

Sessions is accepted at `ab681d4acd824665188f2c6ab9997eecbbf178e0`.
SS-P1–SS-P3 were closed at 5ce2e2d2; this correction closes the remaining
SS-E1 evidence and the three cast removals. The frozen SS1–SS7 assignment is
complete. No correction or production change is assigned.

## Exact revision and scope

- Parent: `5ce2e2d2ca7d4236ff9ceec224cc99dcf365f299`, preserved with
  4ee4f448 and 10b17a40 below it.
- Branch: agent/issue-883-pr2; signature G, tarasm@gmail.com.
- Implementation worktree: `.claude/worktrees/issue-883-pr2`.
- Independently verified clean, with no untracked files, before and after review.
- Five files, +615/−102: three tests and two fixtures. No production source or
  specification changes.

The [frozen plan](pr2-section5-sessions-planner-handoff.md),
[Architect decision](pr2-section5-sessions-architect-decision.md) and
[narrow correction](pr2-sessions-implementor-correction-5ce2e2d2.md) govern.
This verdict includes the production fixes accepted in
[the previous review](pr2-sessions-planner-review-5ce2e2d2.md).

## Remaining evidence is closed

**Stop before the append:** the new operationGate installs contextual
ReplHost middleware at the instrumentation band. It registers cleanup before
the hold, suspends before invoking the underlying append operation, and records
physical completion only after that operation returns. Stop cancels and joins
this suspension. The paired mounted rows observe no physical agent_prompt
append, no saved Prompt and no saved turn in the stopped arm, while the exact
publication key remains a local filter and refuses cold. Releasing the same
boundary saves one physical append, one Prompt and one turn, and the key resolves
cold. The accepted native writer is unchanged.

The older native-Promise row now says what it proves: its key survives the cycle
ending after the append was released. Its assertions remain intact. The old
append-evidence diagnostic is retained as evidence of that fixture limitation;
it is not a required green regression and was not rerun. No claim is made that
an irreversible native append becomes cancellable.

**Read-only ownership:** the real two-chat journey starts with a current
question and partial answer, closes the modal, then visits the older chat.
Question content, partial field and current-chat controls are absent from the
screen. Pressing the former opener's exact cell opens nothing, and ordinary Draft
typing changes only the Draft. Back and explicit reopen recover the same
question and partial answer, without an answer, outcome or replacement question.

The mounted terminal exposes cells and pointer input, not its internal target
list. The visible absence, former-cell activation, actual Draft dispatch and
unchanged pending form are sufficient representative evidence for this frozen
ownership criterion. The assignment also forbids a second host or debug API;
enumerating internal nodes is not an additional requirement for closure.
Closing the modal before navigating respects the existing modal contract.

**Cross-chat identity:** the canonical regression/control is now in the permanent
recovery corpus and asserts exact keys and kinds through the real composition.
The mounted companion reads an older failed chat while the current conversation
fails, preserving every older item and revealing the current failure only on
Back. This complements the unchanged external probe and closes the promotion
requirement.

**Cast-free fixtures:** the harness returns typed SidekickRecord values.
The journey and presentation rows narrow event records by their discriminant;
the serialized fixture event remains serialized text. All three assigned casts
are removed. No new cast is introduced by this commit.

No production or prose change is needed for these evidence corrections. The
operation gate is additive; existing native append gates and callers keep
their behavior. The optional older-failure fixture arm defaults off.

## Independent focused verification

Every command below ran in the implementation worktree against this exact
revision. Complete first output is preserved. Counts are tests / steps.

| Command | Final passing count | First output |
| --- | --- | --- |
| `deno task test packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts` | 30 / 111 | [mounted first output](pr2-sessions-review-ab681d4a-mounted-first.log) |
| `deno task test packages/cli/tests/repl-route.test.ts packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-boundaries.test.ts` | 18 / 87 | [route first output](pr2-sessions-review-ab681d4a-route-first.log) |
| `deno task test packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-agent-journey.test.ts` | 21 / 59 | [agents first output](pr2-sessions-review-ab681d4a-agents-first.log) |
| `deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts` | 17 / 98 | [recovery first output](pr2-sessions-review-ab681d4a-recovery-first.log) |
| `deno task test packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-agent-execution.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-output.test.ts` | 45 / 177 | [entries first output](pr2-sessions-review-ab681d4a-entries-first.log) |
| `deno task test packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-forms.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-source-reading.test.ts` | 71 / 223 | [ordinary first output](pr2-sessions-review-ab681d4a-ordinary-first.log) |
| `deno task test packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-lifecycle.test.ts` | 6 / 39 | [lifecycle first output](pr2-sessions-review-ab681d4a-lifecycle-first.log) |
| `deno task test /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-preview-correlation-probe-b44098ff.test.ts /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-preview-single-item-probe-f8b4e035.test.ts` | 2 / 4 | [preview-probes first output](pr2-sessions-review-ab681d4a-preview-probes-first.log) |
| `deno task test /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-sessions-populated-probe-4ee4f448.test.ts /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-sessions-cross-chat-probe-4ee4f448.test.ts /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-sessions-reveal-probe-4ee4f448.test.ts` | 3 / 6 | [correction-probes first output](pr2-sessions-review-ab681d4a-correction-probes-first.log) |

The seven frozen selections finish at **208 tests / 794 steps**.
The five unchanged probes pass **5 tests / 10 steps** on their first invocations.

The lifecycle selection first failed in the previously recorded L2 row:
expected Elicit:active:question, observed Elicit:enter. With no source, fixture,
assertion, dependency or environment change, the
[isolated rerun](pr2-sessions-review-ab681d4a-l2-isolated-rerun.log) passes
1 / 8 and the
[original two-file rerun](pr2-sessions-review-ab681d4a-lifecycle-rerun.log)
passes 6 / 39. This is recorded in
[the open L2 flake record](pr2-repl-lifecycle-l2-flake-10b17a40.md);
the first failure is preserved and the cause remains unfixed. U2 did not recur.
The correction changes no lifecycle/session/Elicit implementation.

The original three mutation connections are unchanged by this test-only commit.
Their accepted discriminating results stand; the mutation battery was not
repeated. The released/stopped operation pair and permanent cross-chat pair
supply the specifically assigned evidence here.

The Implementor reports deno task check exit 0. The Planner did not rerun broad
check, lint, JSR, runtime suites or CI; none is a feedback prerequisite. The
previously recorded no-yield-in-finally lint error remains separate and must be
resolved before delivery. No push, GitHub write, CI inspection or capture occurred.

## Continuity

Latest accepted head: `ab681d4acd824665188f2c6ab9997eecbbf178e0`.
Preview, Configure/Retry, question drawers, mounted owner acquisition and the
earlier accepted Core/ACP/recovery work remain closed. No Sessions blocker or
Implementor correction remains.

Produced: this review, updated readiness/assignment pointers and the L2 recurrence
record. Next Implementor action: hold at the clean signed head until the next
bounded Planner assignment. Remaining work is full terminal R5–R8 evidence
reconciliation, the 36-frame capture packet and delivery verification. This PASS
accepts the Sessions feedback slice; it does not claim merge readiness.
