# Establish refresh delivery before suppressing another refresh

Completed and accepted at `8b45ee24b254697b72e4479ef7f47a78c9c57f1d` in the
[Planner review](pr2-metadata-planner-review-8b45ee24.md). P1 is closed. These
instructions record the completed correction; continue with the focused
pinnedElicit handoff without repeating this work.

Correct `c5bec4583b9c60ef68f2c52a84fa4e8d298a7dad`, parent
`01990ca4dfca3d9526908ac775469c28f1be7776`, in
`.claude/worktrees/issue-883-pr2`, branch `agent/issue-883-pr2`.

The [Planner review](pr2-metadata-planner-review-c5bec458.md) records one blocker.
A reference is appended before the provider turn. projectSidekick treats that
local record as delivered orientation even if the refresh turn fails, so the
next explicit message omits the required changed context.

## Required correction

Derive the conversation's last delivered orientation from completed canonical
turns that actually carried that retained context. A reference record by itself,
or a matching turn ordinal without the context, cannot establish delivery. Keep
the proposed reference readable after failure/interruption without claiming that
its versions superseded the last established ones. Use the existing journal and
canonical input; do not introduce another delivery authority.

After a failed or interrupted refresh, the next explicit message must still
carry the current orientation. After a completed refresh, the next message must
omit it. Preserve first-turn retry, incomplete-attempt projection, Output-only
chat, no evaluation of failed provider source and no automatic replay/resend.
Cold reopen alone sends and writes nothing. Chapter bodies remain on demand;
comparison and refresh grant no additional response/provider permission.

Update the affected architecture/specification prose to state how delivery is
established. Preserve the accepted Stop and admission/Pause work. This correction
does not require a new product or architecture decision.

## Finite evidence

Read the archived [probe](pr2-metadata-delivery-probe-c5bec458.test.ts) and
[first output](pr2-metadata-delivery-probe-c5bec458-first.log). Integrate the
failed-refresh/next-explicit-message regression and successful-refresh control
in repl-sidekick-journey.test.ts. The failed turn must not establish the current
versions; the next explicit message carries them, a successful completion
establishes them, and the following message omits them. Keep the normal newer-build
refresh row. If the canonical check exposes its synthetic stale reference as
inconsistent with the turn it names, construct an older-build fixture with
matching retained text and canonical input rather than weakening the check.

These two outcomes are the finite addition. No new failure permutation matrix,
terminal work or generic recovery framework is assigned. A mutation that restores
unconditional trust in the latest local reference should fail the regression
while leaving the successful-refresh control green.

Run from the implementation worktree. ROOT below means the absolute directory
`/Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883`:

```text
deno test --config deno.json --allow-all ROOT/pr2-metadata-delivery-probe-c5bec458.test.ts
deno test --config deno.json --allow-all ROOT/pr2-stop-startup-probe-88c482b7.test.ts
deno test --config deno.json --allow-all ROOT/pr2-stop-join-probe-88c482b7.test.ts
deno test --config deno.json --allow-all ROOT/pr2-feedback-receipt-probe-f5b60c99.test.ts
deno test --config deno.json --allow-all ROOT/pr2-feedback-contract-probe-97f8cb79.test.ts
deno test --config deno.json --allow-all ROOT/pr2-owner-failure-probe-e3aaa61e.test.ts
deno task test packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-history.test.ts
deno task test packages/cli/tests/repl-sidekick-output.test.ts packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-route.test.ts packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-agent-journey.test.ts
```

If the older-build fixture is corrected, adapt the archived probe only as needed
to make that same fixture canonical; preserve its failed-refresh regression and
successful-refresh control, and retain the original probe/output. Report the
adaptation explicitly. No session change is required; if session.ts changes,
also run the unchanged repl-journey.test.ts as in the Stop correction.

Commit promptly after the focused evidence passes. Return the exact signed SHA,
parent, all focused commands/results and worktree state for Planner review.
Do not start another increment before this correction is reviewed. No push,
GitHub write, CI inspection or full suite is assigned.

Exact correction base is c5bec458. Stop remains accepted at 01990ca4. P1 is the
only blocker here. The Elicit factory ruling is separately recorded in
pr2-elicit-pinning-planner-handoff.md; configuration, remaining R2 cases and
section 5 remain incomplete.
