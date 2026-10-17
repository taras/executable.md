# Settle the entry writer before binding Submit's prefix

Completed and accepted at `55e5d4a710a6b3bb79e0fff4a205f145ef73df53` in the
[Planner review](pr2-admission-settlement-planner-review-55e5d4a7.md).
The instructions below record the completed correction. Continue with the next
action in planner-handoff.md; do not repeat this correction.

Correct `32bbd7ccdf222c12f850176dc27210d0980d5e04`, parent
`9bb1d465b8b22fdf05cd87b6761791fa2fdb7702`, in
`.claude/worktrees/issue-883-pr2`, branch `agent/issue-883-pr2`.
The [Planner review](pr2-admission-prefix-planner-review-32bbd7cc.md) accepts the
exact-byte binding and changed-prefix refusal. Preserve them. One requirement
from the preceding correction remains: settle outstanding entry appends before
binding the acknowledged prefix and writing Submit intent.

## Required correction

Holding the next slot does not stop a previous entry's append. The current
`EntryJournal` supplies only a path, so `submitForSidekick()` reads it and records
intent while the writer can still be appending. Use the actual execution
writer/session boundary to establish a settled acknowledged prefix under the
root-owned slot. The existing `MovableWriter.settled()` is the repository's
acknowledgement seam; private CLI helper plumbing is delegated. Do not add a
second writer or reconstructed byte snapshot.

Preserve the session's busy, ending and readiness refusals. A busy request must
not become queued work merely because this correction waits for an append.
Establish admissibility before snapshot/intent, and keep the slot ordinal and
entry identity coherent with the settled prefix. Preserve the actual-start
route/revision/liveness checks after suspended preflight.

The order remains: own the slot and establish admissibility; settle outstanding
appends; bind the actual acknowledged bytes; acknowledge intent; attempt entry
admission; retain its outcome. Release or revoke the reservation through its
existing owner when refused or cancelled. Keep ordinary journal grammar,
exact-entry completion, joined teardown and the accepted Pause handoff intact.

Correct comments that equate append-only growth or holding the next slot with
the acknowledgement of an append already in flight. Update affected contract
prose only as necessary to describe this ordering. No product or architecture
approval is needed.

## Finite evidence

Read the [reproducer](pr2-admission-prefix-settlement-probe-32bbd7cc.test.ts) and
[output](pr2-admission-prefix-settlement-probe-32bbd7cc.log). It holds the real
prior entry's append inside the host and observes production Submit intent
while the writer remains in flight. Its settled-prior control passes.

Integrate one held-append scenario and its settled-prefix control. Keep the
assertion that no snapshot/intent is taken from an unsettled writer. Preserve a
busy refusal without converting it to a later automatic submission. For a valid
submission, establish that the retained binding describes its acknowledged
prefix. Adapt the reproducer's synchronization: its current owner releases the
append after the broken call returns, which would deadlock a correct wait.
Use owned latches and the real writer acknowledgement, not sleeps or scheduling
assumptions. No new restart or runtime matrix is required.

Keep R2i/R2j/R2k and their unchanged-history controls. Run the integrated focused
regression/control and these four commands:

```sh
deno task test packages/cli/tests/repl-journey.test.ts
deno task test packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-agent-execution.test.ts packages/cli/tests/repl-sidekick-controls.test.ts
deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-output.test.ts
deno task test packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts
```

Add the existing controller-consumer selection only if this correction changes
that boundary. Capture first failures. Commit promptly when focused evidence
passes and return exact SHA/parent, every command and result, and the
regression/control mapping. Do not wait for full suites, lint/check, JSR or CI.

## Continuity

Base is 32bbd7cc. The linked review, this prompt and planner-handoff.md govern
the correction. Increment 2/P1/A1 and the prefix comparison are accepted;
increment 3/R2 cases 3/4 await this correction. Remaining section 3 wiring,
section 4/R2 cases 2/5/6 and section 5's terminal packet remain incomplete.
Stop for review at the next focused feedback commit. No push, GitHub write, CI
inspection, memory compaction or unrelated PR work is authorized.
