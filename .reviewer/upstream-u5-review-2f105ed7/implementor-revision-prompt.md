# U5 revision prompt — one remaining request-capture defect

Continue as `.agents/implementor.md` in the existing authorized U5 worktree, against feedback SHA `2f105ed738c5da25f348f97f708684aa4adbb4b3`, tree `923829a67736fc213ae72a0e45bf30c4cca105a5`, base `3a1fade9246db937e11da6cdadc4751ec924be97`.

## Applies to

One reproduced failure under frozen U5-5/U5-7. [Planner review](planner-review.md), [probe source](bound-reading-probe.ts), [probe output](bound-reading-probe.log).

## Instructions

The original R1, R2 and R3 fixes are accepted. Preserve authored settled paths and lazy description, case-collision refusal, live-bound WGX9 and the composing REPL fallback. Do not change the accepted ordering, publication or refusal-normalization judgments.

Fix R4: `useWorkflowGenerated()` reads `options.requests` for `captureBounds()` and then reads it again indirectly through `workflowGeneratedSelection(options)`. If a getter returns an empty list first and a non-empty bounded list second, the helper offers Fetch and returns without installing Permissions. Canonical generated Fetch then sends `/not-admitted`; the stable bounded control refuses it.

Reproduce using the retained probe before editing. Capture the request input once and derive both implicit Fetch membership and runtime Permissions from the same owned captured data. Do not reread the original options/request array to decide the selection. Preserve explicit host component extensions and normal property composition. This needs an ordinary local correction, not a new public API, collector, request inventory or preflight policy.

Add one committed regression through the production helper and real captured Evaluate. The first empty request reading must be the retained reading: one read, no implicit Fetch admission, zero transport calls, even though a second getter call would advertise a bound. Keep the existing stable non-empty successful control. Prove this row fails at the reviewed defect, restore the fix and rerun the affected frozen evidence. Keep the twelve-row matrix unchanged.

## Feedback

Commit promptly once the focused evidence passes. Return the exact signed SHA/tree/base, clean status, cumulative diff including new files, commands/results and the before/after output. Retain the first failure. Keep publication, CI inspection, other worktrees, preservation refs and #902 untouched. Full runtime corpora and extra confidence checks are not new prerequisites.

## Read next

Return the new exact feedback revision to the Planner. Only R4 remains blocking; no further architecture decision is requested.
