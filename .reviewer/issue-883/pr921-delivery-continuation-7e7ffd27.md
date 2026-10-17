# Finish #921 delivery after #890 merged

Continue with the same designated Implementor. The Planner has reviewed the
scope of the L2 repair and finds no new product or architecture decision. No
additional feature assignment or full-plan review is needed.

## Current sequence and exact heads

The Implementor reports #890 merged by a human. Actual main merge commit:
`98cd350b08082d57c711b450973257fab6bb8973`, carrying both PR1 commits.
PR1 is complete; do not attempt its merge again.

PR2's current published head is reported as
`7e7ffd27f819073ccb02994dab8ff50bf075a4e7`, parent
`8b8c66d31ba8bda601e2e204f6c0dd39788c3d51`.
Read-only local verification matches this head and verifies its signature G /
tarasm@gmail.com. No tracked owner-worktree changes remain; the retained
untracked troubleshooting notes file stays untouched.

The Implementor reports another writer's rebase onto the merged main preserved
all ten previous commits by range-diff and produced the same tree; their old
line is preserved at `preserve/pr2-delivery-c10a2062`. This continuity record
does not independently claim a fresh remote/main or CI verification.

Latest reported remote state: #921 is still draft and CI is running on
7e7ffd27. Earlier “ready” and c10a2062 green observations are historical. Neither
stacked green nor a result for an earlier head satisfies final delivery.

## L2 repair scope

The inspected commit changes only
`packages/cli/tests/repl-lifecycle.test.ts`, replacing an unconditional five
`sleep(0)` sample with a bounded wait for any occurrence to report nonempty
waiting. The following exact assertion still identifies the sole occurrence,
its element, phase and wait. The readiness condition is narrower than that
claim; it does not poll for the full expected answer. The neighboring empty-
reading observation is unchanged. No production scheduling or lifecycle
behavior changes.

The Implementor reports discrimination: the fixed-count variant failed once
in three six-file runs; the repaired variant passed two six-file runs, three
two-file runs and the file alone. Lint and check pass. These results were not
rerun by the Planner. The test-only repair fits the assigned delivery/flake
work and does not reopen the accepted Sidekick plan.

## Remaining Implementor and human actions

1. Update the delivery handback with the actual #890 merge SHA, PR2's rebase
   receipt, 7e7ffd27, the L2 cause and exact commands/results/first-output links.
   Retain earlier records as historical rather than claiming their tests were
   all rerun at the new head.
2. Record the repair on existing flake issue #935: fixed readiness assumption,
   exact fixing commit, failing/control evidence, runtimes and results. Preserve
   the first failure and do not call an unchanged rerun a repair. Follow the
   issue-writing guide for the update. Keep closure tied to the recorded repair
   and its regression evidence; report closure and landing accurately.
3. Re-read #921's base, draft state and head. Confirm its base is main and mark
   it ready if still draft. Monitor the applicable main-target delivery checks
   on its actual final head. Readiness/base/head changes may trigger another
   run; obtain the verdict authoritative for the state being merged.
4. Resolve attributable failures under the existing delivery assignment,
   preserving first output and re-running affected evidence. No new product or
   persistence choice is delegated. Do not replay completed integration work.
5. Once the exact main-target head satisfies current protection and required
   checks/reviews, have a human perform the normal protected merge of #921, or
   satisfy the applicable execution approval barrier before retrying the same
   authorized operation. Re-read the head immediately before merge. Do not
   switch endpoints/tools or use admin flags to evade the prior denial.
6. Return #921's final head, main-target check/run links, actual merge SHA,
   #935 repair/closure disposition, and any precise unresolved gate. Delivery
   completes only when both PRs are actually merged with their required gates.

The Implementor reports the asynchronous REST merge was denied by automatic
review as “Merge Without Review.” That is an execution barrier, not something
this planning continuation overrides. The earlier `git reset --hard` denial
was resolved by using a new branch; no destructive cleanup is needed or assigned.

## Boundaries

The Planner maintains plans and reviews evidence only. No source, Git ref,
PR state, issue or CI operation was changed by this update. Execution remains
with the designated Implementor and the human merge owner.

#928–#933, broader UI/mockup work, History stacking, conversation labels,
narrow pending questions, Parse #922, teaching and the 36-frame packet remain
separate. REPL.EntryTrace is proposed, not available; Entry 22's temporary-file
cause remains unproven. The original accepted architecture and final delivery
handoff remain authoritative except for the obsolete starting state explicitly
superseded here.
