# Bind Submit recovery to the exact acknowledged entry prefix

Correct #883 increment 3 at `9bb1d465b8b22fdf05cd87b6761791fa2fdb7702`, parent
`29fb689fb2f1cec53aaf8ca49560f29d2892a58d`, in
`.claude/worktrees/issue-883-pr2`, branch `agent/issue-883-pr2`.
The [Planner review](pr2-admission-gate-planner-review-9bb1d465.md) requests one
correction. Increment 2 and its P1/A1 findings remain accepted. Keep the existing
implementation; no reset or delivery split is requested.

## Required behavior

An unresolved Submit must refuse if the entry-journal prefix it reserved has
changed, even when the earlier entry count, reserved ID and reserved source still
match. `session.entries.length` identifies only a slot. It cannot bind the
history before that slot. This requirement is already accepted in
remaining-architecture.md, storage-contract.md and main-plan R2 case 4.

Read the [reproducer](pr2-admission-prefix-probe-9bb1d465.test.ts) and
[first failure](pr2-admission-prefix-probe-9bb1d465.log) from the root checkout's
`.reviewer/issue-883/`. Both histories are valid real session executions: the
reserved entry matches, but `Prior A.` has become `Prior B.` earlier in the file.
The unchanged-history control passes; changed-prefix reconciliation wrongly
returns admitted.

## Correction boundary

- Keep the entry ordinal separate from the prefix binding. Retain the exact
  acknowledged entry prefix at a record boundary before acknowledging Submit
  intent. Use the repository's existing record-count, UTF-8 byte-count and
  SHA-256 fingerprint approach to bind the actual retained bytes; do not
  re-encode parsed records and call that the same byte prefix. Reuse the
  machinery/approach in sidekick/history.ts for fingerprinting and copied-prefix
  verification. Internal helper shapes remain delegated.
- Take that snapshot while the root owns the slot and after outstanding entry
  appends have settled. Preserve the existing readiness/teardown checks; no
  competing submitter may change the prefix between binding and admission.
- Carry the binding through the strict Submit record, ControlJournal's reserved
  payload, reservation/projection types and cold reconciliation. The reader must
  have enough of the real entry history to compare it; the array of entry
  keys/sources alone cannot establish a journal prefix. Refuse missing or invalid
  required binding data instead of treating the ordinal as an old binding.
- Verify the bound prefix before either an absent or admitted finding. A
  matching prefix followed by the exact reserved entry/source remains admitted;
  a matching prefix with no reserved entry remains absent. Valid later suffix
  records are allowed. A mismatch stays refused before a resolution or new entry
  is written. Keep cold projection free of writes and provider work.
- Preserve intent-before-admission, exact-entry completion and joined teardown,
  one-time Pause handoff, responsive input, actual-start checks and the ordinary
  entry-journal grammar. Update the affected specification/architecture prose so
  it describes the retained prefix binding rather than just an entry count.

The private CLI seams, staged conversation facts and suspended-append subprocess
interruption are accepted. Do not replace them or invent another recovery owner.
Correct the R2 comment claiming a third process: `again` is another projection
inside the reconcile process. No third process is required by this correction.

## Focused evidence and handback

Integrate one representative changed-prefix regression and its unchanged-prefix
control into the existing recovery/control tests. Preserve R2i/R2j and existing
ID/source/short-history refusals. Adapt the archived probe's input construction to
the real new prefix binding if its private signature changes; preserve its
observable assertion. This fills the existing changed-prefix criterion, not a
new runtime, corruption or crash matrix.

Run the corrected regression/control, then the four existing focused commands:

```sh
deno task test packages/cli/tests/repl-journey.test.ts
deno task test packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-agent-execution.test.ts packages/cli/tests/repl-sidekick-controls.test.ts
deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-output.test.ts
deno task test packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts
```

Add the existing controller-consumer selection only if the correction touches
that boundary again. Capture the first failure output before rerunning. Commit
promptly when focused evidence passes; return exact SHA/parent, every command
and result, the regression/control mapping and remaining claims. Do not wait
for full suites, lint/check, JSR or CI before the feedback commit.

## Continuity

Base is 9bb1d465b8b22fdf05cd87b6761791fa2fdb7702; governing artifacts are this
prompt, the linked review and planner-handoff.md. The exact-prefix decision is
settled, with no new product approval required. Increment 3 and R2 cases 3/4
remain unaccepted until the corrected feedback commit is reviewed. Remaining
section 3 wiring, section 4/R2 cases 2/5/6 and section 5's terminal packet remain
incomplete. Stop for review after the correction. No GitHub write, push, CI
inspection, memory compaction or unrelated PR work is authorized.
