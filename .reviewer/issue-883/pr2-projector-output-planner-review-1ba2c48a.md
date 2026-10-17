# PR 2 projector correction, recovery case 1 and output reads

REQUEST CHANGES at `1ba2c48a9e610eba30faabd433592222d95c104b` for
feedback-delivery verification and R2 case-1 evidence. The pure output-window
implementation passes its scoped review.

Both findings below are closed by the
[PASS review at 8b4efe91](pr2-correction-planner-review-8b4efe91.md).
Their reproductions describe `1ba2c48a`.

Reviewed commits:

- `ae88acbee038df2e55e376184701e2018768a580`, parent
  `fdf67b0417147aef4447a56d4555133d27df85c1`: projector correction and recovery
  tests.
- `1ba2c48a9e610eba30faabd433592222d95c104b`, parent `ae88acbe`: pure output
  read resolution and its tests.

## Accepted parts

The projector uses Core's public Prompt reader and refuses a response whose
owning turn has no retained completed Prompt. That resolves the absent-response
owner assertion in the earlier review. A local delivery marker with no
completed owning turn is now reported as unestablished, which preserves the
need for reconciliation without claiming delivery. Both archived probes pass.

The pure output module correctly resolves selectors, the default or stated
limit, code-point offsets, immutable observed chunks and pinned adjacent read
instructions in the reviewed R4 cases. The 21 rows pass. The helper for a
Submit's initial read instruction is accepted as a pure helper. These findings
do not accept root observation/buffering, interrupted-entry presentation,
literal feedback formatting or Submit's eventual integrated receipt. Those
remain part of the planned integration evidence; the user explicitly leaves
root buffering and Submit integration unclaimed here.

## P1 — A completed ordinal still does not establish the claimed feedback

`sidekick/model.ts:321` reduces a completed canonical Prompt to a turn number.
At line 401, membership of that number alone makes the local marker a delivered
fact. The projector does not check the canonical Prompt's input against the
input whose delivery the marker claims.

This is the remaining part of the earlier canonical-reference finding. The
previous correction prompt explicitly rules out inferring acceptance from an
ordinal alone. A canonical turn proves that turn happened; it does not prove
different feedback was carried by it.

The submitted positive control R2d already demonstrates the problem. Its
`turn()` fixture writes canonical input `"ask"`, while the feedback record
claims `"results"` was delivered. The assertion counts delivery anyway.

The new focused probe supplies two completed canonical turns and a response
owned by the first. Its feedback marker names the second turn:

- With canonical input `"an unrelated prompt"` and retained feedback
  `"results"`, projection still reports delivery. The negative assertion fails.
- With canonical input `"results"`, the same delivery is reported. The positive
  control passes.

Keep enough retained information to establish that the named canonical turn
carried the exact intended next-turn input, including the ordered feedback and
context. Compare that account with the canonical Prompt description and owning
turn; an ordinal, a substring match or a local marker alone is insufficient.
If the feedback text is only part of the assembled input, retain the exact
assembled input/correlation rather than pretending the part is the complete
request. Missing acceptance remains visible for reconciliation; contradictory
canonical input must not become a delivered fact. Keep this read pure.

This unit check does not replace R2 case 6, which still arrives with the real
conversation owner and interruption before the local acknowledgement.

## P2 — R2 case 1 uses new scopes, not new processes

R2g at `repl-sidekick-recovery.test.ts:311` writes inside `scoped()`, then reads
inside another `scoped()` at line 337. R2h does the same at lines 361 and 373.
The fixture installs a new host in each scope but launches no child process.
Both phases run inside the same test process and share loaded module state.

These are useful real-filesystem reopen tests. They are not the frozen
fresh-process evidence. Comments naming the scopes “one process” and “a second
process” are inaccurate. The handoff expressly requires subprocess restart at
both sides of case 1: before ready and immediately after ready/writer handoff.

Use actual independent writer and reader processes over the same temporary
directory. The writer reaches the production publication boundary and stops;
the later reader independently loads the production host and repository.
Assert the before-ready refusal and unchanged original, and the after-handoff
pair/origin and exact prefix. Observe no reopening append or Sidekick provider
work. Synchronize the interruption by an observed boundary, not elapsed sleep.
Only persisted files and explicit test parameters cross the process boundary.
Correct the test descriptions and mapping accordingly.

## Focused evidence

Run independently from `.claude/worktrees/issue-883-pr2` at `1ba2c48a`:

```sh
deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-output.test.ts
deno test --allow-all --frozen --config deno.json /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-section2-storage.probe.ts /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-projection-fdf67b04.probe.ts
deno test --allow-all --frozen --config deno.json /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-feedback-1ba2c48a.probe.ts
```

The three submitted tiers pass: 11 tests, 56 steps (27 storage, eight recovery
and 21 output cases). Both archived probes pass: two tests, nine steps. The
new feedback probe fails its mismatched-input assertion and passes its matching
control. Its first output is preserved in
[pr2-feedback-1ba2c48a.probe.log](pr2-feedback-1ba2c48a.probe.log), with its
[source](pr2-feedback-1ba2c48a.probe.ts) beside it.

The Implementor reports the three integration suites and Node/Bun output,
lint and check passing. They were not independently rerun in this review. No
CI was inspected. The implementation worktree stayed clean at the reviewed
head. Only reviewer artifacts changed.

## Revision prompt and continuity

From `1ba2c48a`, finish canonical feedback verification and replace the
scope-only R2 case-1 evidence with actual subprocess writer/reader phases.
Correct R2d's positive fixture so the canonical input really carries the
retained feedback. Add the demonstrated same-turn/different-input negative
case and retain the matching-input control. Keep the accepted pure output
module and the earlier storage/response-owner corrections.

Run the three focused tiers and archived probes above. Once that evidence
passes, return a feedback commit with exact SHA/parent, commands/results and a
truthful case-1 mapping. The remaining sequencing is unchanged: cases 3/4 with
section 3's production Submit gate and reconciliation, and cases 2/5/6 with
section 4's conversation owner. R2 remains open until all six boundaries pass.
The final PR 2 threshold remains R1–R8 and the 36-frame packet.
