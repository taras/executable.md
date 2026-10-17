# #921: correct submission identity; keep other agent feedback separate

The Product Owner's scope ruling is: correct defects introduced by this PR;
track pre-existing defects and additional capabilities separately. The four
items in the agent's feedback do not constitute one correction assignment.

At `940249af47159a3bbd960b8ca8df3f10bb53811c`, **REQUEST CHANGES** for the
submission identity finding below. The correction belongs to #921's Sidekick
submission and recovery path. Parse behavior, binding publication semantics,
and new access to intermediate agent results are excluded.

## Disposition of the four items

| Feedback | Evidence and disposition |
| --- | --- |
| Invalid Parse should fail the document | Separate, pre-existing Core defect: [#922](https://github.com/taras/executable.md/issues/922). Parse and SafeParse have identical blobs at PR base `79d404d0` and reviewed head `940249af`. Do not implement it in #921 or make it a condition of #921 acceptance. |
| Receipts must identify the submitted work | The saved session proves incorrect attribution. Current-head testing narrows the remaining defect: the persisted reservation names an older entry, while the current completion receipt and output-read instruction name the actual new entry. Correct the reservation and historical-opening recovery in #921, preserving the correct completion handle. |
| Persistence should be understandable | The saved entries contain ordinary Let bindings and captures, with no eval operations publishing root state. An empty published map therefore does not establish a PR regression. Clearer publication guidance or a different publication interface is separate follow-up work; do not change inheritance, Let, captures, or the binding-map response here. |
| Inspect intermediate agent replies and validation results | Agent prompt results are already journaled. Exposing additional inspection to Sidekick is a separate capability request, not evidence that #921 lost those results. Follow up on reading existing records without repeating agent prompts. |

The latter two rows are proposed follow-up scope, not accepted designs or newly
created GitHub issues. #922 already tracks the first row. This record does not
alter unrelated assignments or authorize GitHub writes.

## What the saved session establishes

Execution: `204bb2d1735dbceaa20efaa5f5d8d77a`.
Selected Sidekick conversation: `a53a836be355a1edefe23ee68b79a607`.
The supplied location selects `entry-4:close:root` and contains an unsent draft.
Neither the location nor its draft was executed. Only saved files were read.

In `sidekick.jsonl`, zero-based record 236, `response:27`, records a Submit
reservation with `ordinal: 4`, `entry: "entry-5"`, and a bound entry prefix of
232 records. In `entries.jsonl`, record 232 starts the eighth admitted entry.
Its source is byte-for-byte equal as a parsed string to that reservation's
source. Feedback records 240 and 242 contain:

```text
Entry entry-5 completed.
Read what it printed with <REPL.EntryOutput entry="entry-5" limit={4096} />.
```

Thus the saved feedback names Entry 5 for work actually admitted as Entry 8.
The history does not identify the exact executable revision that produced it;
do not claim the old receipt wording has been reproduced at the reviewed head.

Read-only evidence snapshot:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| entries.jsonl | 5,972,803 | `61beb05058d4f314cc8fd13efa94144eb26e0a2bf1ffe11d63760ccd49dab887` |
| sidekick.jsonl | 2,229,335 | `1eb67abe1e2c000a0c04c086db811f6bdba1aa770bd8eabace1ff623d195ba13` |

The files remain in the user's application data directory. Their private
conversation, entry bodies, and unsent draft are not copied into this packet.

## Current-head reproduction and direct trace

Use two completed entries, open the session at the first entry's checkpoint,
then submit from the live head. Returning to the live route is necessary:
submission while still viewing a frozen checkpoint is correctly refused.

```text
Saved history:          Entry 1 -> Entry 2
Open at Entry 1:        session.model contains Entry 1
Return screen to live: displayed reading contains Entries 1 and 2
Sidekick Submit:
  saved reservation:   Entry 2             WRONG
  actual new entry:    Entry 3
  completion receipt:  Entry 3             correct at current head
  output-read target:  Entry 3             correct at current head
```

The focused probe uses a real on-disk repository, real ReplSession, and
submitForSidekick, with the same session adapter as program.ts. Its journal
captures the intent rather than opening an agent conversation. It represents
returning to the live route with the same `live: true` fact the root derives
from `state.route.at === undefined`. It is not a mounted terminal test.

The head-opening control passes. The historical-opening arm prints:

```json
{"selection":"close:root","openingEntries":1,"actualEntries":["entry-1","entry-2","entry-3"],"reserved":"entry-2","ordinal":1,"receipt":"entry-3","read":"entry-3","reconciliation":"this chat reserved `entry-2` under a source the entry history does not hold for it, so what that entry ran cannot be established as what was reserved."}
```

The expectation that the reservation names Entry 3 fails. The completion receipt
and read-target assertions pass before that failure.

Relevant data flow at the reviewed head:

1. `session.ts` keeps `session.model` projected at the session's opening
   `selection`. `reading(undefined)` separately supplies the full acknowledged
   history. Screen navigation calls `reading()` and does not change the
   opening selection.
2. `program.ts:1038` supplies `current.model.entries` to submitForSidekick.
   `admission.ts:234` counts that list and persists the reservation before
   submission. Consequently a historical opening supplies an older count even
   after the screen returns to the live head.
3. `session.ts` submits against the full acknowledged history and returns the
   actual entry's completion handle. `admission.ts:310` uses that handle for
   the completion receipt. Preserve this part.
4. `program.ts:725` also supplies the opening projection to coldReservation.
   With an unanswered valid reservation for a later entry, opening an earlier
   checkpoint can therefore produce a false disagreement or an incorrect
   absent finding. Recovery must examine the full history independently of
   where the screen opens.
5. `program.ts:2847` derives the person's reservation from the same opening
   projection. It does not persist a Submit intent, but it shares the incorrect
   next-slot calculation. Keep the two submitters' next-entry identity coherent.

All three root uses are introduced by this PR. The older-history projection is
an existing REPL feature; changing what a frozen screen displays is unnecessary.

## Why this changes the architecture verdict

The settled REPL contract already requires a Submit intent to identify the
exact source, entry and preceding history, and requires reopening to match an
unanswered intent without repeating work. See `specs/repl-spec.md:1150–1187`;
the exact completion/read-target contract follows at `:1460–1486`.

This is a supported path: open a copied historical location, return to the
live head, and ask Sidekick to submit. It changes durable state by recording
the wrong entry identity. An interruption before the control outcome leaves
recovery unable to identify the work that actually ran. Current resolved()
correctly refuses the mismatched source; weakening that check is not a fix.

The earlier PASS at d906c636 did not cover this newly evidenced historical-
opening path. This return adds the explicit structural finding above; it does
not reopen accepted configuration, provider, Parse, or ordinary display work.

## Bounded Planner correction prompt

Prepare one correction assignment for #921 on branch `agent/issue-883-pr2`,
worktree `/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`,
reviewed clean head `940249af47159a3bbd960b8ca8df3f10bb53811c`, parent
`ff0e52c643c21ad7dde34908a18a112add6312c7`, PR base
`79d404d04d02c3840892473b6f1b2cf540f3edd1`. Recheck advancement and coordinate
with the existing stack-integration hold; this return authorizes no rebase,
reset, merge, push, CI inspection, or unrelated implementation.

Restore the existing contract: a submission's reservation, actual admitted
entry, terminal outcome and output-read target identify the same work,
regardless of the history position at which the command originally opened.
The saved history and focused reproduction above demonstrate the violation.

Require these observable corrections:

- Sidekick reserves the next entry in the full acknowledged history, not after
  the command's opening checkpoint. Preserve the writer-settlement ordering,
  shared submission slot, exact source/revision checks, cancellation and
  refusal while the screen is still frozen.
- Cold reconciliation uses the full acknowledged history. Opening a historical
  location must not conceal an admitted entry or manufacture a disagreement
  for an otherwise valid pending reservation. Preserve refusal for genuinely
  mismatched histories and sources, and preserve no automatic resubmission.
- The person's Run uses the same correct next-entry identity. Preserve the
  actual task-bound completion handle; do not reconstruct a receipt from a
  selected list length.
- Add a mounted regression that opens a copied historical location, returns
  to the live head, submits, and inspects the durable intent, admitted source,
  receipt, and output-read target together. Include a head-opening control.
  Cover a failed entry as well as a successful one so the outcome stays linked.
- Include interrupted Submit recovery when reopening at an earlier checkpoint,
  with both an admitted and an absent reservation. Show that reading/recovery
  does not repeat entry effects or agent prompts. Keep the existing changed-
  history refusal control.

Use the existing session's acknowledged reading and completion capabilities;
no new public Core API, new provider configuration behavior, or alternate
identity authority is required. Leave the local implementation shape delegated.

Exclude #922, generic component error handling, changed Let or capture
persistence, new publication APIs, binding-map metadata, new agent-result
inspection APIs, and repair or rewriting of the user's saved files. Record
adjacent findings as separate follow-up candidates. Do not add broader fixes
merely because the supplied history exercises them.

## Evidence and workspace state

Probe source is parked outside active test discovery:
[pr921-historical-opening-reservation-probe.test.ts.txt](pr921-historical-opening-reservation-probe.test.ts.txt).

Command run at the reviewed head, after temporarily copying the probe into
`packages/cli/tests/`:

```text
deno task test packages/cli/tests/pr921-historical-opening-reservation-probe.test.ts
```

The first run used the wrong spelling for the first entry's checkpoint:
`entry-1:close:root` rather than the compatibility spelling `close:root`.
Its complete output is preserved in
[the first log](pr921-historical-opening-reservation-probe-940249af-first.log).
That was a probe setup error, not a product finding or a flake.

With that marker corrected, the head control passes and the historical-opening
arm fails on the wrong reserved entry. Complete output:
[corrected-marker log](pr921-historical-opening-reservation-probe-940249af-corrected-marker.log).

The temporary test was removed after the run. Implementation HEAD remains
940249af and its worktree is clean. No source, specification, saved user history,
commit, GitHub record, or CI state was changed. The correction is not implemented.
