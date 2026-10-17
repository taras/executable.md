# Handback at f83e3554 — submission identity corrected; one pre-existing failure returned

HI1–HI6 are implemented and the three assigned commands ran. Commands 1 and 2
are green. **Command 3 fails on exactly the two rows that already fail at the
assigned base**, which is returned below as a concrete limit rather than fixed
or hidden.

## Revision

- SHA: `f83e35549dcddad0791f9492b8cdfe56dd7b4bf1`.
- Parent: `940249af47159a3bbd960b8ca8df3f10bb53811c`, preserved, as is every
  ancestor. No reset, amend, rebase, merge or push.
- Branch `agent/issue-883-pr2`; signature G, tarasm@gmail.com; clean before and
  after.
- Nine files: `program.ts`, `sidekick/admission.ts`, five test/fixture files,
  `architecture.md`, `specs/repl-spec.md`.
- **Not pushed.** This assignment authorizes a signed correction commit only, so
  PR #921 still names `940249af`.

## The correction

All three root uses now read the whole acknowledged history through the
session's existing `reading(undefined)`:

| Site | Was | Now |
| --- | --- | --- |
| `program.ts` submitForSidekick adapter | `current.model.entries` | the acknowledged reading, as a `Result` |
| `program.ts` coldReservation | `current.model.entries` | the acknowledged reading; an unreadable one blocks admission through the existing refusal |
| `program.ts` submit action | `session.model.entries.length` | the acknowledged reading's length, refusing if unreadable |

`AdmittingSession.entries` became `entries(): Result<readonly AdmittedEntry[]>`
— the one `sidekick/admission.ts` change the handoff anticipated. It is a
function because the moment matters: it is read after `writer.settled()`, with
nothing suspending between the count and `take`, so the slot and the bound
prefix are readings of the same file. It is a `Result` because an unreadable
history must supply no count: reserving the first slot on that basis would
claim a slot somebody else's entry holds.

Unchanged, as directed: the completion receipt and output-read target still come
from `submission.entry` and `submission.join()`; the two readiness checks, the
byte-prefix binding, the actual-start recheck, the source-mismatch refusal and
the shared admission slot keep their order and their meaning; no new Core API,
counter, projection owner or cached head snapshot; a frozen screen still shows
exactly the position it named.

## Evidence, and the baseline

The HI1 historical arm was written **before** any production edit and captured
failing at the base, with its head-opening control passing — preserved in
[the baseline](pr921-hi1-baseline-940249af-first.log):

```text
- "entry-3",  - 2      (expected)
+ "entry-2",  + 1      (received)
```

That is the Architect's reported reservation exactly.

| Row | Destination | What it observes |
| --- | --- | --- |
| HI1 | `repl-sidekick-presentation.test.ts`, Tier HI | Two entries, a copied location frozen at the first entry's outcome, `[live]`, then a reply's Submit. Saved intent `entry-3`/ordinal 2 with its exact source, the admitted entry `entry-3`, and the retained feedback carrying both `Entry entry-3 completed.` and `<REPL.EntryOutput entry="entry-3" limit={4096} />`. Head-opening control on the same path. |
| HI2 | same tier | The same transition with source that is admitted and then throws: intent, failed entry, `Entry entry-3 failed.`, `It failed:` and the read target all name `entry-3`; the earlier two entries stay `ok`. |
| HI3 | same tier | Frozen, Run establishes nothing and the draft keeps its text; live, the same Run admits `entry-3` with its literal source and the draft is cleared by the entry it became. |
| HI4 | `repl-sidekick-recovery.test.ts`, Tier HI | Subprocess phases leave two completed entries and an `admit` interruption; the mounted program reopens at the first entry's outcome. Opening appends nothing and calls no provider; the next mutating action retains `{status:"ok"}` observing **`entry-3`**; the reserved source is not re-run and the ordinary entry takes the next slot. |
| HI5 | same tier | The same with a `reserve` interruption: no append, no provider turn, no admission of the reserved source, then `absent` retained before a distinct ordinary entry takes `entry-3`. |
| HI6 | commands 1–3 | R2i–R2l, the changed-history and source-mismatch refusals, shared admission, held preflight, Stop, task-bound receipts, ordinary Run and historical navigation all unchanged. No assertion weakened. |

HI4/HI5 reopen **through `runReplProgram`** over the phases' own on-disk root
with an opening location, so `program.ts`'s cold adapter is what runs — not
`coldReservation` called here with a list this file chose.

### The two defects discriminate

Rather than only a sequential baseline, each half was reverted on its own
against the final tree:

| Reverted | HI1–HI3 | HI4/HI5 |
| --- | --- | --- |
| only the cold site | pass | **fail** |
| only the two live submitters | **fail** (HI1, HI2) | pass |

So correcting live Submit cannot appear to close cold recovery, or the reverse.

**HI3's stated limit:** it passes under the live-only revert, because the
person's reservation writes no intent and has no display — the admitted entry
comes out right through the session's own submit regardless of the private
ordinal. The source is what establishes that half: `program.ts`'s submit action
and `admission.ts` now both take their count from `reading(undefined)`. No
inspection API was added to expose it, as directed.

## Commands

```sh
deno task test packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts
deno task test packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-controls.test.ts
deno task test packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-journey.test.ts
```

| Command | Result |
| --- | --- |
| 1 | exit 0 — 35 tests / 128 steps, 0 failed |
| 2 | exit 0 — 14 / 72, 0 failed |
| 3 | **exit 1** — 64 / 164 passed, **2 failed**: `EH1` and `UI10` in `repl-entries.test.ts` |

`deno task check` exits 0.

## Returned limit: EH1 and UI10 predate this correction

Both fail with truncated text, for example:

```text
Expected value: "No entry output recorded at this checkpoint."
Received array: ["No entry output recorded at this"]
```

Established, not assumed:

- They fail **identically at the assigned base `940249af`** with this round's
  work removed from the tree — 19 passed, 2 failed. Preserved in
  [that run](pr921-repl-entries-preexisting-at-940249af.log).
- They still fail with `fitting.ts` restored from `ff0e52c6`, so the bounded
  width-measurement batching in `940249af` did not cause them.
- Command 3's failure set on the final tree is **exactly those two**, so this
  correction adds none.

Finer attribution needs a prepared worktree per commit: checking single files
out of earlier commits does not typecheck, because `program.ts`,
`application.ts` and `layout.ts` moved together across these rounds. That is
bisection work this bounded correction does not authorize, and `repl-entries.test.ts`
was not in the command sets of the last several rounds, which is why it surfaced
only now. No assertion was weakened and nothing was changed to obtain a pass.
[Command 3's first output](pr921-command-3-first.log) is preserved.

## Fixture adaptations

Five consumers carried the `AdmittingSession` change. Each keeps its claim:

- `fixtures/.../recovery-phase.ts`, and both sites in
  `repl-sidekick-recovery.test.ts`: `entries: () => live.reading(undefined)`'s
  model entries, propagating a reading refusal — the way the root reads it.
- `fixtures/.../sidekick-harness.ts`: the same, mapped to key and source.
- `repl-sidekick-lifecycle.test.ts`: the hand-built session answers `Ok([])`.
- `Ok` was added to that file's existing `effection` import.

In `repl-sidekick-presentation.test.ts`, Tier HI's receipt observations read the
retained `feedback` records rather than the screen, because `renderReceipt`'s
text is what the next turn is sent — the same records the reported
misattribution was found in. Two mechanics were needed and are worth recording:
a History outcome row carries no entry number (`pointLabel` says that only for
an admission), so the first entry's outcome is `2 · Entry outcome recorded`; and
a copied location carries the drawer that was open when it was copied, so the
footer's `[live]` is unreachable until that drawer is closed.

## Scope

#922, Parse/SafeParse, Let and capture persistence, binding-map contents,
publication APIs and intermediate agent replies are untouched. B, C and D's
pending UI choices are untouched. No stack integration, rebase, push, GitHub
write, CI inspection, dependency/cache/lock change or capture.

## Continuity

Base `940249af`. Produced `f83e3554` and this handback. Settled: submission
identity and cold recovery read the acknowledged history. Returned: EH1/UI10 as
a pre-existing failure needing its own bounded assignment. Next action: review
this commit.
