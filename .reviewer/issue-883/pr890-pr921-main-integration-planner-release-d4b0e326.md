# Start replacement PR1 on the verified main target

**Released integration completed, 2026-10-16:** PR1 is accepted at 85da74b9
and PR2 is [PASS at 7613cddf](pr921-replacement-planner-review-7613cddf.md).
The worktree coordination for further assignments names the session reporting
the 7613cddf verification handback as the sole Implementor for PR2; other
sessions hold edits. The two-session overlap produced no duplicate successor
and requires no branch rewrite. Preserve all accepted/original/safety refs.
No further integration work or publication is released. The exact EH1/UI10
delivery obligation and queued UI decisions below remain unchanged. Earlier
release/start instructions are historical where superseded.

**Phase 2 is now released, 2026-10-16.** Replacement PR1 is
[PASS](pr890-replacement-planner-review-85da74b9.md) at
85da74b938434773d7faf3caa5e2ca007328fdca. The review gate below is satisfied.
Use the [updated prompt](pr890-pr921-main-integration-implementor-prompt.md)
to start replacement PR2 from that exact SHA. C's separate preservation ref
exists and is verified; both original branches and older safety refs remain
unchanged. The start-state table records the original release, not current
checkout state. All scope limits and the EH1/UI10 disposition below still apply.

**Released for implementation.** Follow .agents/implementor.md and execute the
[combined integration plan](pr890-pr921-main-integration-planner-handoff.md)
under this exact-base release. Build replacement PR1 first; return its signed
feedback SHA with the five PR1 commands and stop for review. Do not start PR2's
implementation until replacement PR1 is accepted.

This is a re-implementation on two new local branches, not a rebase of the
reviewed stack. Accepted code and tests are references for the port. Do not run
rebase, reset, amend or replace the original PR branches. No publication is
authorized.

## Verified start state

Read-only checks on 2026-10-16 establish:

| Item | Exact value |
| --- | --- |
| Remote main, read with git ls-remote | 986948eabd070c0ae7354c2a0db8df7feed63621 |
| Local origin/main | 986948eabd070c0ae7354c2a0db8df7feed63621 |
| Original PR1 branch | agent/issue-883-pr1 at 79d404d04d02c3840892473b6f1b2cf540f3edd1 |
| Original PR1 worktree | .claude/worktrees/issue-883-pr1, clean |
| Accepted source C | agent/issue-883-pr2 at d4b0e326d76fa63c6ee7a97e189986bbd371243d |
| Original PR2 worktree | .claude/worktrees/issue-883-pr2, clean |
| Existing PR1 safety ref | pre-rebase/issue-883-pr1 at 79d404d04d02c3840892473b6f1b2cf540f3edd1 |
| Existing PR2 safety ref | pre-rebase/issue-883-pr2 at d906c6360533aaf894f5424dd4689aceedf08c3b; older than C |
| Planned integration branches | Neither exists |
| Planned C preservation ref | pre-integration/issue-883-pr2-d4b0e326 does not exist |

The first remote read failed in the network sandbox with DNS resolution failure.
The approved read-only retry succeeded and returned the exact target above.
Neither read changed a ref, remote or worktree. No CI was inspected.

## Preservation and owner coordination

The Implementor who supplied the hold/recheck owns this sequential integration
assignment. Work in the existing PR1 worktree for the first phase. Keep PR2's
files and checkout untouched until the PR1 review. Do not run another overlapping
writer in either worktree during its assigned phase. If another owner advances
or dirties one, preserve that state and return the concrete coordination conflict.

Before any implementation port, create a new C preservation ref without moving
either existing safety ref:

```sh
git branch pre-integration/issue-883-pr2-d4b0e326 d4b0e326d76fa63c6ee7a97e189986bbd371243d
```

Verify it names C. If the name now exists, verify its owner and target rather
than overwriting it. This shared-repository safety ref can be created from the
PR1 worktree; it does not require changing PR2's checkout or files.

In the clean PR1 worktree, create agent/issue-883-pr1-main-integration at the
exact verified main SHA. Preserve agent/issue-883-pr1 at its reviewed head.
Prepare the changed committed dependency layout once using deno task setup, as
the plan specifies. Implement the final bound Core surface directly: move the
existing Core-only binding/owner and conversation evaluation method earlier;
preserve main's capture and marker-4 fragments; roots use marker 5. No temporary
siteless or table-taking host evaluator.

On passing the frozen PR1 evidence, create its signed feedback commit and stop
for review. A stable commit is not withheld for PR2's unfinished work.

Only after a recorded PASS on that exact replacement PR1 SHA, create
agent/issue-883-pr2-main-integration from it in the clean PR2 worktree. Carry the
accepted behavior through C and implement the plan's setup-time Sidekick control
capture. The original PR2 branch stays at C. The existing architecture and this
release authorize that second phase once PR1 is accepted; no new product choice
is delegated to the Implementor. Return the second signed feedback SHA with the
seven PR2 commands and stop for review before publication.

## Explicit EH1/UI10 disposition

The original submission-correction command 3 fails at both 940249af and
f83e3554 on the same two labels:

- EH1 expects `No entry output recorded at this checkpoint.` and sees
  `No entry output recorded at this`.
- UI10 expects the complete guidance ending `Tab/Shift+Tab move` and sees
  the truncated guidance ending `Tab/Shift+Tab ` at the recorded wide frame.

The [independent first output](pr921-historical-identity-review-f83e3554-command-3-first.log)
and the Implementor's [base output](pr921-repl-entries-preexisting-at-940249af.log)
preserve those failures. Their onset is unestablished; this release does not
claim they predate #921 or classify them as flakes.

**Planner disposition:** retain them as a separate bounded test/fitting
follow-up. They do not block starting or accepting the integration feedback
when the integrated run exhibits only those same baseline truncation failures
and all other assigned evidence passes. This explicitly amends the integration
feedback threshold; it does not skip or weaken the tests.

Run the full named PR2 command 6, including repl-entries.test.ts, and preserve
its actual exit code, complete first output and pass/failure counts. Report it
as red if these failures remain. The exception covers those exact baseline
observations, not merely their test titles: changed symptoms, new failures or
an integration-caused loss of behavior are returned and corrected under the
plan. Do not silently retry them until green or replace their expectations with
the truncated strings.

No EH1/UI10 repair, bisection or test migration is assigned in this integration.
If integration naturally removes the failures without changing their meaning,
report the actual green result and why; no speculative repair is needed.
Otherwise the separate follow-up remains required before the branch is offered
for merge. CI/delivery gates are unchanged. No GitHub issue or CI action is
authorized by this disposition.

## Scope and continuity

IN1–IN8, the five PR1 commands, seven PR2 commands, PR split and architecture
decision remain frozen except for the explicit feedback-baseline disposition
above. Old histories remain readable as history and new turns use current
controls; no migration or suffix replay. HI1–HI6 is closed at C and is carried,
not reimplemented as another correction assignment.

Parse #922, binding publication/agent-result inspection, B–D, teaching, captures
and unrelated cleanup remain separate. No force push, GitHub mutation, CI
inspection, merge, original-ref rewrite, user-history repair or cleanup.

Produced release: this file; the integration plan, prompt and readiness records
now point here. Next Implementor action: preserve C, create the replacement PR1
branch in its owner's worktree, prepare once and implement PR1. This Planner
turn changed only reviewer documents and performed read-only state checks.
