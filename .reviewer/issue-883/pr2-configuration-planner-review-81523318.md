# Configure/Retry review: PASS at 81523318

C-P1 Apply ownership is closed. The bounded Configure/Retry slice is accepted
against the frozen CFG1–CFG9 matrix. C-P1's inspection half, C-P2, C-P3, C-P4,
C-E1 and all prior accepted slices remain closed.

## Exact revision

- Reviewed: `815233183c7c26cd40544347191b7ba5e1f975c3`.
- Parent: `57773de05246578da77c0f8689fbee004cbd84b4`, preserved.
- Branch: agent/issue-883-pr2; signature G, signer tarasm@gmail.com.
- Implementation worktree: `.claude/worktrees/issue-883-pr2`.
- Tree clean, no untracked files; five files, +230/−51.

HEAD, parent, signature and clean status were independently verified, including
after the focused tests. The governing assignment is
[the narrow Apply correction](pr2-configuration-implementor-correction-57773de0.md)
under [the frozen plan](pr2-section5-configuration-planner-handoff.md),
[the timing ruling](pr2-section5-configuration-timing-architect-decision.md)
and [the product decisions](pr2-section5-configuration-product-decisions.md).

## Apply ownership

Configure carries a process-local selection revision. Opening, choosing a model
or effort, and editing the agent name advance it. Closing preserves the count,
so reopening cannot reuse the revision of an Apply still running. The save and
replacement intents carry that revision through separate completion reports.
The replacement intent also retains the agent actually requested.

applied() checks the open drawer, originating conversation and selection
revision before changing the screen. Its own success closes the drawer; its own
failure preserves the selection and reports the reason. A later edit or reopen
invalidates the earlier report even if the scalar values match. No acknowledged
save is rolled back, and no durable record or Core/ACP interface changes.

The unchanged [three-step Apply probe](pr2-configure-apply-report-probe-57773de0.test.ts)
passes both regressions and the ordinary replacement control:

```text
replacement: { preference: true,  activated: true, drawerStillOpen: false }
replacement: { preference: false, activated: true, drawerStillOpen: false }
laterAgentEdit: { saved: true, drawerStillOpen: true }
```

All three are promoted into the existing mounted CFG4 tier. Activation and
preference records are read from disk; the held physical save makes the later
agent edit precede completion. The existing landed() helper is moved to module
scope for reuse. No new host, projection, journal or fixture is introduced, and
no existing assertion is weakened. These adaptations are accepted. The spec and
architecture prose match the implemented selection rule.

## Independent focused evidence

All nine commands below ran from the implementation worktree against this exact
revision. Each linked first-output log records the full `deno task test`
invocation and result. The six selections are unchanged from the frozen plan.

| Selection | First result | Full command and output |
| --- | --- | --- |
| Sidekick presentation / journey / lifecycle | 20 tests / 72 steps | [mounted](pr2-configuration-review-81523318-mounted-first.log) |
| Entries / history / agent-execution / Sidekick controls / output | 51 / 201 | [entries](pr2-configuration-review-81523318-entries-first.log) |
| Sidekick storage / recovery / configuration | 16 / 89 | [recovery](pr2-configuration-review-81523318-recovery-first.log) |
| Journey / agent-interface / agent-journey / forms | 71 / 185 | [journey](pr2-configuration-review-81523318-journey-first.log) |
| Route / layout-admission / presentation-style / source-reading | 28 / 130 | [layout](pr2-configuration-review-81523318-layout-first.log) |
| Execution / lifecycle | 6 / 39 | [lifecycle](pr2-configuration-review-81523318-lifecycle-first.log) |
| Unchanged Apply report probe | 1 / 3 | [Apply probe](pr2-configuration-review-81523318-apply-probe-first.log) |
| Unchanged Configure boundary probe | 1 / 4 | [boundary probe](pr2-configuration-review-81523318-boundary-probe-first.log) |
| Unchanged writer cancellation probe | 1 / 2 | [writer probe](pr2-configuration-review-81523318-writer-probe-first.log) |

All first runs pass: **192 tests / 716 steps** across the six selections, plus
**three probes / nine steps**. No rerun was needed and U2 did not recur. Its
previously recorded cause remains unfixed; this result does not close
[the existing local flake record](pr2-mounted-permission-u2-flake-a438905f.md).

The Implementor reports check = 0 and two additional discriminating mutations,
restored byte-identically. The Planner did not repeat check or those mutations.
The preserved parent-SHA failure and current passing probe already satisfy the
assigned discrimination threshold. No broader suite or CI result is used.

## Disposition and next action

Accept the Configure/Retry slice at `815233183c7c26cd40544347191b7ba5e1f975c3`.
No correction remains assigned. Hold this clean signed head until the next
Planner assignment. Streamed preview, Sidekick Sessions integration, remaining
complete terminal R5–R8 acceptance, the 36-frame capture packet and delivery
remain deferred; this feedback verdict is not merge readiness.

Produced artifacts are this review and updated readiness pointers in README.md,
planner-handoff.md, pr2-section5-configuration-planner-handoff.md and the closed
Apply correction prompt. No implementation edit, commit, push, GitHub mutation,
CI inspection or capture was made by the Planner.
