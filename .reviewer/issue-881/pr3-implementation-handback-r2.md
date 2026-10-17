# PR 3 revision handback: R1–R4

Revised from `f509197bd1998b376b09986b79fce2740568e76f` against the four
findings in [the Planner review](pr3-planner-review.md), and against
[the R2 evidence correction](pr3-r2-evidence-correction.md). Branch
`agent/issue-881-pr3`, base `acadbbdb4fa7d8c8c86fa85f6657d29c5d95bc3e`.

**Revision: `05ba70d567cb80be4bfdea67e7ae0267376e2376`**, amending
`3fa241dccd1ca3128d7026dbdd529efc7b401ef0` with the R4 and R5 corrections from
[the second review](pr3-planner-review-r2.md). One signed commit, worktree
clean, nothing pushed and no PR open.

Three of the four are closed as asked. The fourth, R2, is closed in substance
and differs from the frozen wording in one ordering step, for a reason the
product forced and which is recorded with its own probe evidence.

## R1 — one root snapshot, and full refusal after admission

**The root change is in.** `ReplSession` now hands both halves over together:

```ts
reading(at: string | undefined): Result<ReplReading>   // { model, navigation }
```

built from one slice of the acknowledged array, memoized on that array's
length and the position asked for, with the head derived on read because
pausing, resuming and the last of an entry's resources being released all move
it while the file stands still.

`program.ts` keeps one `reading` value where it kept a `model`. Every branch
assigns both halves or neither; `build()` takes the prepared reading instead of
asking `session.navigation` again; and the per-frame composer recomposes *that*
reading at a new size. The shortcut that returned without reading when the
route and model selections matched is gone, and with it the window the review
described: the terminal size read between resolution and composition suspends,
and a record retained during it used to move navigation under content that had
already been projected.

A reading that cannot be built at all now draws the **refused view** — the same
screen a cold open of that file shows — rather than a route notice over a stale
prefix. That is kept distinct from a route that does not resolve at its
position, which still keeps its reading and says the reason beside it.

The head is now derived in exactly one place (`headNow`). It had to be: the
first cut of this change created a second derivation, and KC5's mutation then
hit only one of them and reported UNBROKEN. That is in the control record.

New regressions, in `repl-history.test.ts`:

- *refuses the whole reading once an admitted session can no longer read its
  file* — an **admitted** session, not a cold one: a duplicate of the entry's
  own last record is appended to the live stream, both `reading(early)` and
  `reading(undefined)` refuse, and `session.model` is still the model it was,
  not quietly refreshed. This is the shape of the Planner's own probe.
- *answers both halves of one position from one acknowledged array* — the same
  position read either side of an append: content does not move, navigation
  does, and the pair agrees with itself.

The root-level half of this is the corrected offscreen journey under R2: a real
append arriving while a prefix is inspected, with the drawn frame's content and
order read from the same screen.

## R2 — advancement with the head held

**The captures now show a held head.** All three `offscreen-advance` frames say
`HEAD · EXPANSION PAUSED`; the audit requires that string and forbids
`HEAD · LIVE` for this state, so the green result can no longer be had with the
superseded frames.

**The frozen ordering is not performable for these shapes, and this is why.**
R2 asked to establish the controller hold and *then* release work that already
started. The controller reports paused only when every active expansion walk
is satisfied, and a walk suspended inside an already-started provider
operation has not necessarily reached such a gate — so Pause requested there
can correctly stay PAUSING until that operation returns. Four shapes of
outstanding work were tried in the real command —
a `<Plan>` held at its provider gate inside `<Spawn>`; a spawned component body
polling for a latch; an Agent permission request held at its gate; and a
spawned body suspended on a single `fs.watch` event, which is the frozen
`HistoryGate` fixture shape — and in every one the head stayed at
`PAUSING EXPANSION` for as long as it was watched, with `[continue]` never
offered. The probes and their timings are in
[pause-boundary-probe.md](pr3-evidence/pause-boundary-probe.md); `HistoryGate.ts`
is kept beside the other fixtures so the fourth probe can be re-run.

This is about expansion walks, not about all Effection work or resource
lifetime: the probes below say what these four shapes do, and nothing broader.
The order the journey performs, which the Planner has since recorded as the
correct one, is: start the work, request the pause against it (`PAUSING`,
which is what says the request is real and the work outstanding), inspect an
early prefix, then release the started work — its records append with nothing
typed and nothing activated in the frozen view, and the hold establishes as it
finishes. Every assertion the row names is then made: a real retained append
(journal records), growth of the whole navigation list (the last ordinal the
drawer lists, walked to the end before and after, and **compared**), unchanged
exact selected content and selection caption, and `HEAD · EXPANSION PAUSED`.
Opening and closing History while still inspecting leaves the head held, the
prefix and the selection standing, and offers no Continue there — the action
row at a frozen position is read only. Only after returning live is the real
Continue required and activated through the controller, after which the entry
reaches an outcome and the head reads `SETTLED`.

That the pause is requested against work that is genuinely in hand is checked
rather than assumed — the stage reads the provider's own log and refuses to
proceed until a Plan turn has been taken and not answered. Two earlier runs of
this stage recorded a head that had already settled, which is exactly what that
check now prevents.

## R5 — the repository's rules on the newly committed files

Three changes, all in the direction the review named.

**No production casts.** `session.ts`'s memo held optional `whole`, `prefix`
and `failed` fields and then asserted two of them with `as ReplModel`. It now
holds one `Result<ReplProjections>` — a pair that either exists or a failure —
built by a single `project()` helper. Nothing asserts a payload the shape
could lack, and no public interface changed. The repository's own
`prefer-effection-result` rule then caught two places where I rebuilt an
already-narrowed failure with `Err()`; both now return the failure itself.

**The probe is out of shipped source.** `HistoryGate.ts` took its `fs.watch`
before registering the release, which Code Rule 16 forbids, and it used
`node:fs/promises` where the repository requires Effection operations. The
corrected journey does not use it — the pause is requested against the Plan
provider — so it is removed from `packages/` rather than rewritten, which is
the alternative the review offered. Its exact bytes are retained at
`pr3-evidence/probes/HistoryGate.ts`
(sha256 `ea46a4d6add24b286d6158a24405413ebbae2f9963cc902d4f4d759b016e18d2`)
and the probe record points at them, so the fourth probe can still be
repeated. No executable repository source now takes a watcher before
registering its cleanup.

**The controlled host follows the same rules.** Both latch paths are narrowed
once, at the edge, by a `latches()` function that exits if either is absent —
so everything below holds two strings rather than asserting them. Its
filesystem work is `writeTextFile` and `exists` from `@effectionx/fs` instead
of direct `node:fs/promises`. The host's architecture is unchanged: one real
installation holding its own teardown, no fabricated head state, and the
accepted gallery's `settling-head` still comes from it.

## R3 — KC3 against a real held invocation

`repl-presentation-style.test.ts` gains **P1-T4**: a session opened with
`submitReplEntry`, an `<Elicit>` that actually suspends, and the frame composed
from that session's own overlay — `lifecycle: session.lifecycle`, not an
`observing(...)` fixture. Nothing in the test names a phase. The assertion is a
committed cell: the row carrying `● WAITING` is the one holding `<Elicit`, and
its foreground is `LIFECYCLE.hold.colour` from the independently sampled
archive, while the source beside it keeps its own colour.

KC3's existing mutation fails it. The control now also records, for all five
controls, the **complete** captured output in `.controls-output/<id>.log` and a
first-failure block that runs to the end of the failure including its stack
locations, rather than an excerpt cut at 1,400 characters.

## R4 — what grouped actions actually select

**The first submission's oracle was false, and the review is right about why.**
`diamond_column()` scanned all five band rows and returned the first `◆`.
Row 1 carries the right-hand `◆ SELECTED · N` caption and comes before
row 2's actual rail mark, so the helper reported the caption's column — 145 —
for every selection, and the equality it checked agreed with itself. Positions
18 and 19 were chosen because they were the first consecutive
`Component admitted` rows, with nothing establishing that their marks shared a
column. They do not: the handback's 18/19 "one mark" claim was wrong and is
withdrawn.

**What the repaired journey reads.** `rail_diamond_column()` reads band row 2 —
the marks above the rule — and nothing else. The pair is no longer the first
consecutive one: candidates are tried in recorded order, each member is
actually selected, its rail column read, and the walk stops at the first pair
whose two columns are equal. Which pair that is, is the layout's answer.

Measured at **160×36**, zero-based rail columns, from the rebuilt packet's
`grouped-candidates` and `grouped-selection` records:

| Candidate | Rail columns | Verdict |
| --- | --- | --- |
| 18 · Component admitted / 19 · Component admitted | 10, 11 | not one mark — rejected |
| 19 · Component admitted / 20 · Component admitted | 11, 12 | not one mark — rejected |
| **20 · Component admitted / 21 · Component admitted** | **12, 12** | one mark — chosen |

The 18/19 columns reproduce the review's independent reading exactly. The
chosen pair is 20 and 21 rather than the review's 23 and 24 — both are
genuinely shared; 20/21 is simply the first in recorded order, and the walk
takes the first it can prove.

What each selects, with the catalog scrolled rather than read from one frame:

| Position | Caption the band draws | Component scopes the prefix admits |
| --- | --- | --- |
| 20 · Component admitted | `SELECTED · 20` | 3 |
| 21 · Component admitted | `SELECTED · 21` | 4 |

One mark on the rail, two positions behind it, two different exact markers, and
content differing by exactly the component admitted between them. The
later-marker action is unchanged: position 218, the end of the order, selected
directly while inspecting, with the band named to it.

**Correction, after the acceptance review.** This section previously said the
counts above were recovered by walking the catalog one row at a time with a
one-row movement check. They were not. `journey.py` carried **two**
definitions of `admitted_components()` — the scrolling one and an older
single-frame one later in the file — and Python used the later one, so the
scrolling walk never ran. The acceptance review caught this and the annotation
is right.

What that does and does not affect: the 3 and 4 above are counts of the
complete visible prefixes at 160×36, where both fit in one frame, and the
review independently verified them. So the frozen H1 criterion stands on
evidence that is correct. What was wrong was my account of how it was
produced, and a single-frame count must not be relied on at a narrower
profile, where admitted scopes can fall outside the window and read as none.

The duplicate is now removed: `journey.py` holds one `admitted_components()`,
the scrolling one, and its module docstring is a docstring again — both copies
came from the same bad edit, which inserted a definition ahead of the file's
opening string. The counts in this packet were **not** re-derived with the
corrected helper: the acceptance review requested no further gallery run, and
re-running one to restate a number the review has already established
independently would be work nobody asked for. Any later run of this journey
will use the scrolling count.

`repl-history.test.ts`'s focused regression is unchanged and still passes: two
hundred real component admissions, groups measured by the real layout engine at
160, 120 and 72 columns, sharing pairs intersected across all three widths, and
the later prefix admitting exactly one more scope than the earlier.

## The two corrections the R2 decision named

Both were real and both are fixed.

**The counts are now compared.** The stage recorded `checkpoints_before` and
`checkpoints_after` and never compared them. It does now, and the comparison
is what fails the stage rather than a number in a log:

```
offscreen-advance  records 294 → 296   checkpoints 225 → 226   HEAD · EXPANSION PAUSED
```

Both counts are read the way the correction asks: records from the retained
file, checkpoints by walking the History drawer to the end of the order with
its own control, before the release and again after it.

**Continue is no longer looked for during inspection.** Step 6 now opens and
closes History while still inspecting and requires the *paused head*, the
selected prefix and the selection to survive — and asserts that the frozen
view offers **no** Continue, which is the read-only action row the correction
describes. Only after returning live does step 7 require the real Continue,
activate it through the controller and carry the entry to an outcome:

```
hold-survived-history   HEAD · EXPANSION PAUSED   (no Continue offered)
offscreen-continued     HEAD · SETTLED            (after [live] → [continue])
```

A third thing the rebuild needed, which is worth recording because it twice
produced a false green: the stage now proves the provider actually has a Plan
turn in hand before requesting the pause. "The entry is running" stays true
after a turn has come back, and a pause requested then is a pause against
nothing. The check reads the provider's own log positionally — request ids are
per session and are reused, so every turn in this journey is request 2.

## The frozen commands, the controls and the packet

Both unchanged frozen commands, on `05ba70d5`:

```
deno task test packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-model.test.ts \
  packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-entries.test.ts \
  packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-composition.test.ts \
  packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-journey.test.ts
→ ok | 99 passed (312 steps) | 0 failed

deno task test packages/cli/tests/repl-source-reading.test.ts packages/cli/tests/repl-forms.test.ts \
  packages/cli/tests/repl-agent-journey.test.ts
→ ok | 19 passed (111 steps) | 0 failed

git diff --check            → exit 0
git diff --cached --check   → exit 0
deno task check             → clean
```

The five controls, run from the packet against the amended worktree, each
restored and SHA-verified, with complete captured output per control in
`.controls-output/<id>.log`:

| Control | Outcome | What it breaks |
| --- | --- | --- |
| `KC1-token-drift` | BROKEN | named XMD and JSON cells against the archive literal |
| `KC2-no-rails` | BROKEN | `draws a rail on every row, in the colour of the region it is in` |
| `KC3-no-lifecycle` | BROKEN | **P1-T4**, the frame of a real held invocation, plus the waiting/EXIT unit rows |
| `KC4-label-list` | BROKEN | H4's placement, collisions and hierarchy, and H1's grouped-pair prefix case |
| `KC5-unowned-head` | BROKEN | H3's SETTLING case, through the single head derivation |

The packet is `pr3-evidence/`: **all 77 pairs rebuilt end to end** on this
revision rather than patched — the retained location had drifted off the
gallery execution during the repair, and a self-consistent packet is worth
more than three re-taken frames. `comparison.html`, 27 contact sheets,
`capture-runbook.md`, `gallery-manifest.json`, `actions.jsonl`,
`pause-boundary-probe.md`, `probes/HistoryGate.ts`,
`revision-provenance.json` and `sha256sums.txt` over all 557 files. The audit
requires the held head for `offscreen-advance` and rejects `HEAD · LIVE`:

```
77 captures checked, 0 failed; 76 draw the band, 70 draw a mark on its rail
```

This run's R2 figures, from `actions.jsonl`:

```
offscreen-advance        records 262 → 264   checkpoints 220 → 221   HEAD · EXPANSION PAUSED
hold-survived-history    HEAD · EXPANSION PAUSED   (no Continue offered while inspecting)
offscreen-continued      HEAD · SETTLED            (after [live] → [continue])
settling-released        HEAD · SETTLED            (after the held teardown was let go)
```

Cold hashes are identical across the reopen in journal bytes, journal lines,
journal SHA-256 and provider-log SHA-256.

The provenance note stands and is recorded in `revision-provenance.json`: the
captures were taken from this worktree shortly before the amended commit
object existed, against product source byte-identical to `05ba70d5` — the tree
was clean when it was amended, nothing under `packages/` changed between the
last journey stage and the amend, and the controls restore every file they
mutate. The committed files are hashed there, with the retired probe's bytes
and hash beside them.

Nothing is pushed. No PR is open. No public artifact links are claimed, and no
acceptance is asserted.
