# PR 2 — follow execution and read its result

Implementor handback for `.reviewer/issue-881/pr2-implementation-handoff.md`.
Not pushed; no PR opened.

| | |
| --- | --- |
| Branch | `agent/issue-881-pr2` |
| Head | `acadbbdb` (full SHA in `pr2-evidence/revision.txt`) |
| Parent | `9163a16b` |
| Integrated base | `c7d54769` = accepted PR 1 `080b6ec80ca74e614789e8d2252857ac281df7e5` + main `4c0414be1010f69f11bff0d1d634623a5b08f886`, merged mechanically with no conflict |
| Commits on the base | 17 |
| Gallery | `.reviewer/issue-881/pr2-evidence/` — 44 pairs, 16 contact sheets, captured from this unchanged head |

## The frozen focused commands, and what they returned

Run from the prepared implementation worktree at `acadbbdb`, **exactly as the
handoff writes them**.

```
deno task test packages/core/tests/component-expansion.test.ts \
  packages/core/tests/source-inspection.test.ts packages/core/tests/component-api.test.ts \
  packages/core/tests/invocation-scope.test.ts packages/core/tests/invocation-failures.test.ts \
  packages/core/tests/invocation-identity.test.ts packages/core/tests/expansion-metadata.test.ts \
  packages/core/tests/scanner.test.ts packages/core/tests/document-targets.test.ts \
  packages/core/tests/document-target-execution.test.ts packages/core/tests/evaluate-component.test.ts
→ ok | 53 passed (414 steps) | 0 failed        exit 0

deno task test packages/cli/tests/repl-source-reading.test.ts \
  packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-entries.test.ts \
  packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts \
  packages/cli/tests/repl-forms.test.ts packages/cli/tests/repl-journey.test.ts \
  packages/cli/tests/repl-agent-journey.test.ts
→ ok | 94 passed (316 steps) | 0 failed        exit 0
```

The previous handback folded two more files into the CLI half. That was the
frozen command altered, so it is undone: the command above is the handoff's,
unchanged, and the two files are reported beside it rather than inside it.
`repl-lifecycle.test.ts` and `repl-agent-execution.test.ts` hold this slice's
session reading and its waiting reasons, so the rows L1–L3 are decided there:

```
deno task test packages/cli/tests/repl-lifecycle.test.ts \
  packages/cli/tests/repl-agent-execution.test.ts
→ ok | 14 passed (52 steps) | 0 failed         exit 0
```

git diff --check                                → clean
deno check --frozen packages/core packages/cli/src → 0 errors
```

Reported actual results, not an acceptance number. The whole CLI corpus was also
run at the previous head (`b1264a6d`): **290 passed (1423 steps), 0 failed**; it
is not re-run here because the handoff says no full corpus precedes the feedback
commit.

## What was built

**Layer 1 — the canonical invocation is surrounded.** `ComponentApi.expand`
dispatches one branded request per expansion, claimed once; a handler delegates
it or refuses, and decides nothing about the outcome. Settlement is readable
whether or not the chain returned. Phases are ENTER, ACTIVE, EXIT and then one
terminal COMPLETE or CANCELLED carrying `Result<void>` and a detached frozen
report — no canonical identity, binding or resource crosses. Completion follows
the whole dispatch, middleware cleanup included. Subscriptions register with the
latest phase and then receive each change in order; a slow, absent or cancelled
reader delays and cancels nothing. Every authored path is surrounded: components,
`<If>`, `<Each>`, `<Loop>`, `<All>`, `<Switch>`, the selected `<Case>`, the
`<Else>` that runs, and each `<Spawn>`.

**Layer 2 — static boundaries without execution.** `inspectSource(text, kind)`
answers where each recognized element's delimiters are, from the scanner's own
walk, with no name resolved, no schema compiled, no prop evaluated and no
component invoked. The document envelope is read lexically and `parseSource`
asserts the two agree, so a divergence is loud rather than a quiet offset drift.

**Layer 3 — a session-owned live reading.** Private `lifecycle.ts`: one
occurrence key per actual call, lineage bound around the delegation with
`Context.with`, consumers run on the session's own owner so they outlive the
dispatch, waits counted per element by whoever actually waits, and the whole
reading dropped when the entry closes. `Component.expand` is classified as a
gate in the boundary inventory. The liveness release moved into the entry's
finalizer.

**Layer 4 — the reading on the screen.** `source-reading.ts` turns one model
entry into Output and then Source; `fitting.ts` cuts that reading to the
transcript's measured inner width by asking the engine how wide text actually
is. Rails say which region a row is in; badges say what the element owning it is
doing, glyph and word, against the pane's right inner edge, on each delimiter's
first row only. Generated source replaces its producer inside the enclosure
bytes the author wrote and keeps its own offsets as a child region. The reading
has its own process-local window, keyed by execution, prefix and entry, with
`[↑ earlier]`/`[↓ later]` outside the moving content.

**Specifications.** `architecture.md` (the `Component.expand` capability row,
the expansion-observation section, three REPL module rows),
`specs/executable-mdx-spec.md` §5.7 and §5.8, `specs/repl-spec.md` (observation
versus syntax, output and source, canonical inspection, wrapping, arrow labels).
Present tense; recovery, resource ownership and prefix isolation preserved; it
states explicitly that observations are ephemeral and that static syntax or a
retained admission does not prove active execution. Core root and `/api` exports
remain distinct.

## R4, from the re-review

`pr2-planner-rereview.md` closed R1–R3 and every housekeeping finding, and
found one blocking defect left.

**A question's preview lost long lines.** The message was split at its newlines
and each logical line became one drawer row. A drawer row is one row — so a
long line had nowhere to put its tail, and a window can only scroll to rows
that were prepared. At 72×20 the README confirmation showed
`"summary": "A lightweight workspace for coordinati` and no continuation, in
all eleven windows the review walked. Approve stayed reachable, which is why
reaching the controls never caught it.

The preview is now fitted by the same engine-measured wrapping the reading
uses, at the drawer's own width, prepared in `prepareFrame` beside it. Its rows
are what the description places, what the window counts and what a scroll moves
through. `fitPlain` is the reading's cutting without the rail and status
reservation: read-only text in a box uses all of the box.

`drawerContentRows` is deleted. The review cited it as counting logical lines,
which it did — and nothing called it. A dead function stating a rule the
product no longer follows is worse than no function.

**The regression took two corrections, both worth recording.** Asserting on
description labels proved nothing: a label always held the whole line, and the
loss happened at the row. Asserting the decisions stay reachable proved nothing
either — the reviewed build satisfied that. What discriminates is that no
message row is wider than the drawer it was measured for, together with every
logical line being recoverable from the rows it was cut into. **K14** restores
one row per logical line and fails on `drawer:message:4` overflowing.

**And the terminal agrees.** `pr2-evidence/preview-traverse.py` walks the real
confirmation at 72×20 the way the review did — thirteen windows, through the
drawer's own control — and `preview-traverse.json` records every row it saw:
the tail `agents."` is present and the whole summary is recovered from the
fragments. Worth noting the needle: the value now wraps as
`A lightweight workspace for` / `coordinating coding` / `agents."`, so the
review's contiguous `ng coding agents.` appears in no window and my first probe
reported a false failure on it. The frozen gallery capture
`plan-review-160x36.txt` shows the same fix on the Plan schema: it continues
past `description: "Name` instead of stopping there.

## The Planner's journey review, and the three things it found beyond R1–R3

`pr2-planner-review.md` returned REQUEST CHANGES alongside the independent
structural review. Its journey findings and packet findings were all mine, and
all are fixed:

**A 2.8 MB test log was committed into the branch.** `.cliall.log` entered at
`108fa00c` and `.controls.json` at `a210e4eb`, and
`git diff --check c7d54769..HEAD` exits 2 on the log's trailing whitespace. I
had been running `git diff --check` against the *working tree*, which is clean
and checks nothing about the committed change — so this gate had been failing
for six commits while I reported it passing. Both files are removed and
`.gitignore` names them; the endpoint check now exits 0.

**K1 was not the control it claimed.** It said "remove the rails" and
recoloured one. Making it actually remove them returned **UNBROKEN**: every
case read `line.rail`, the model's answer, and nothing asserted a rail reaches
a row — the reading could have lost its rails entirely and the suite would have
passed. There is now a case checking that each composed row opens with the rail
glyph under the role naming its region, with an observed rail among them so
painting every row alike does not satisfy it. K1 removes the rails and fails.
The recolouring mutation stays as **K1b**, named for what it does.

**A control record kept only the matcher line.** The runner now preserves the
whole first failure; K1's reads `- "│"  + "  "` against the row key.

The review also records that the evidence packet was being rebuilt while it was
read — only 37 of 319 listed files matched, and the manifest and sheets were
absent. The packet is now built once from the reviewed SHA and checksummed
last, and `shasum -c` verifies every listed file against the tree.

Its own live walk stopped at step 3's approval on a missing Plan session
directory, with another evidence run active against the same host storage. The
review names that as a possible cause rather than an established one, keeps the
remaining live steps, and says not to reassign them. They are not reassigned
here.

**The other run was mine**, and the collision is now impossible from my side.
On macOS the REPL keeps its histories under `$HOME/Library/Application Support`
and the Plan provider keeps its sessions under `$HOME/.xmd`, with no override
for either — so my gallery harness and a concurrent review walk were writing to
and deleting from the same directories. The harness is given a home of its own
(`DENO_DIR` still points at the real module cache, because `--cached-only` has
to find what is there). The journal this packet's cold counters measure is now
under `/private/tmp/xmd-881-pr2-home/...`, which the counter files record.

This does not establish the cause of that failure — only that a review run
after this revision will not be sharing storage with mine.

**The same change would protect the review run itself, and has not been made
to it.** `pr2-planner-evidence/harness.py` still resolves the journal under the
real home (line 399, `/Users/…/Library/Application Support/xmd/repl/…`) and
sets only its own `CWD` (line 24). So the remaining live steps are still
exposed to *any* other run on this Mac, not only to mine — and three other
sessions are open on it. I have not touched that file: it is the review's
harness and its evidence, and editing either would contaminate what the
Planner is measuring with.

The change, if wanted, is the one in `pr2-evidence/harness.py`: give the tmux
command its own `HOME` and keep `DENO_DIR` on the real module cache so
`--cached-only` still resolves —

```python
HOME = pathlib.Path("/private/tmp/xmd-881-planner-home")
COMMAND = " ".join(["HOME=%s" % HOME, "DENO_DIR=%s/Library/Caches/deno" % pathlib.Path.home(), ...])
```

— and read the journal from `HOME / "Library" / "Application Support" / …`
instead of the user's. On macOS neither path has an environment override, which
is why the collision is possible at all.

## The Planner's independent review, and what it found

`pr2-independent-architecture-review.md` returned **REQUEST CHANGES** with
three findings against the reviewed commit. All three reproduced on the
Planner's own probe, all three are fixed, and the probe now passes clean:

**R1 — a terminal carried a request its invocation did not issue.** The brand
check proved a request was Core's and unspent; nothing proved it was *this*
element's. An authentic, unconsumed request belonging to another live
invocation, delegated through this one's `next`, reached the claim — it spent
that element's one claim and ran this body, and the refusal that followed came
after the effect had happened. Each terminal now compares the delegated
request with the one it issued, by identity, before the claim and before any
body. The probe went from `bodies:["A"]` to `bodies:[]`.

**R2 — the lexical envelope disagreed with the installed extractor**, and the
assertion I added to `parseSource` turned that disagreement into a refusal of
documents the engine accepts: a BOM with no header, an unterminated header, and
a closing delimiter with text after it. I had written the helper from the
delimiter prose; I derived the real rule by comparing against `matter()` over
twenty-four envelope shapes. A BOM is never body even with no header; an opener
with no closing line consumes the whole text; a closing line *starts with*
`---`, and the body begins immediately after those three characters plus one
line ending if one is there.

One of my own C5 cases asserted the opposite of all of this —
`SI2: an unterminated header is not a header` — and is corrected. That text is
a header with no body, and its value parser refuses it outright, so inspection
claiming an executable element inside a document nothing will run was the worse
of the two answers. A new case checks offset *and* suffix against `matter()`
across every shape.

**R3 — published observations were mutable.** One phase object reaches every
subscriber and is retained as the latest, so a reader could rewrite a terminal
phase to `active` and a late reader would be told that. Phases are frozen
before publication, and an `AggregateError`'s `errors` array is frozen as well
as the error around it — freezing the error alone leaves the explanation every
other reader holds editable.

K11, K12 and K13 join the controls, one per finding.

## A handback claim the review corrected

The review is right and I was wrong: `renderer.measure` already copies each
bound into a new map and freezes it, so `ReplMeasured.boundsOf` does **not**
close over live engine state. My note claiming otherwise is withdrawn, and the
geometry snapshot it justified is removed — the journeys pass without it, which
is the test that says it was never the fix for the drawer defect I attributed
to it. That defect's real cause was the reading's controls not being reserved
in the pass that measures the window, which the same commit fixed separately.

## Two defects this slice found in itself

**The engine's geometry dies at the next render.** `ReplMeasured.boundsOf`
closes over engine state, not over a copy. Preparing the reading between the
third measurement pass and `admissionFor` meant every window's capacity came
from the probe tree: the question drawer was admitted shorter than the one on
screen, a form field's row fell outside its window and lost its Tab stop, and
the agent journey typed two answers into one field. Every bound the pass gives
is now copied into a map before anything else is measured. This is the rule
`planning-measurement.md` states; the existing passes satisfied it only by
accident of ordering.

**A self-closing element lost the badge it settled with**, because the reading
it had was attached to a closing delimiter it does not have. Also: badges align
at the right inner edge rather than at a shared start column — `▶ ENTER` and
`✓ SETTLED` are different widths — and the reading's two controls must be
reserved in the pass that measures the window, or the one it grows is drawn over
the reading's last row.

## Replaced presentation premises, itemized

The transcript's per-record rows are gone, so fourteen assertions across five
suites were re-anchored. Every behavioural claim is preserved; none was deleted
and none was weakened without saying so.

| Suite | Assertion | Old anchor | New anchor, and why |
| --- | --- | --- | --- |
| `repl-presentation-style` | a settled document's result is output, not an outcome | `line:<at>:0` | `reading:output:0`, plus the caption saying it is the retained result and not live |
| | a root with no result shows its outcome and its reason | `line:<at>:0/1` | `reading:output:outcome:0` and `reading:output:reason:0`; the caption now says the absence of rendered text is what is being reported |
| | live text reads as output | `line:live:0` | `reading:output:live:0`, plus the caption saying it is still arriving |
| | the ink of each of those | row's first cell | the text's own span — every reading row opens with its rail, which says where the row is, not what it is |
| | output, metadata and two outcomes are four readings | a transcript `binding` record beside the output row | a subordinate row that still carries that reading; the Bindings column's row is a *value*, not a fact about an event |
| | a long row stays inside its pane | the transcript's `entry`/`scope`/`agent` records, bounded by shortening | the reading's rows, fitted by measuring; the exercise is a line that needed more than one row |
| | an empty screen's pane surfaces | the pane's bottom-right cell | the bottom-right of its viewport — the reading's `[↓ later]` is now the pane's last row, and a control carries the draft's surface wherever it is (this terminal's existing rule) |
| `repl-entries` | each entry shows its own transcript | with nothing selected, every entry's records concatenated | with nothing selected, the last entry admitted; the claim this case exists for — no reading shows another entry's — is unchanged and still asserted |
| | the live overlay belongs to the entry running it | `… ` prefixed rows | the Output half's rows plus its `Output · live` caption; the ellipsis per row is redundant once the caption says it once |
| | no prefix shows output it had not retained | the whole transcript | the Output half alone; the Source half correctly shows the source each prefix *did* admit |
| | a long recorded reason is on screen and bounded | one clipped row ending in `…` | the reason recovered from the rows it was wrapped into, and asserted to contain no `…` — the stronger claim |
| `repl-agent-interface` | a filtered or narrow frame mounts no transcript rows | `line:` | `reading:` |
| `repl-journey` | nothing is waiting | `Decide?` absent from the screen | no question is pending; the reading shows the `<Elicit>` the word is written in, and source on the screen never proved anything was waiting |
| | a drawer covers what it is in front of | two transcript record texts | two lines of the reading; `Source` and `Checklist` would have collided with `summarySource` and `<Checklist /> admitted` in the drawer's own list |
| | the generated fragment's source is on screen | its row above the effect row admitting it | recovered from the Transcript column's rows, because the reading wraps rather than clips; the admission row is no longer in this pane |
| | a cold process reconstructs the fragment | `generated admitted:` | the catalog row naming the reconstructed region |
| `repl-agent-journey` | both Plan reviews are retained where they were asked | counted anywhere on screen | counted after selecting the scope that holds them, which is where the product says they were asked |
| | the program's own two questions | same | same, under the generated fragment |
| | answering the form | clicked the first matching label | clicked inside the drawer that is asking — the reading shows the question's own schema, so its `title` is on the screen twice |

## The seventeen controls

Run alone against `acadbbdb`, one mutation at a time, each restored from the
source and byte-compared afterwards. Record: `pr2-evidence/.controls.json`;
runner: `pr2-evidence/.controls.py`.

| Control | Mutation | First failure | Restored |
| --- | --- | --- | --- |
| K1 rails | the rail is removed from every reading row | S4 — a composed row no longer opens with its rail | bytes identical |
| K2 badges | `badgeRuns` returns nothing | S4 — no glyph and no word where a phase was observed | bytes identical |
| K3 appended | the enclosure's own content is emitted *as well as* the fragment | S1 — the producer is on the screen beside what replaced it | bytes identical |
| K4 clipped | a wrapped line stops after its first row | S2 — the line cannot be recovered from its rows | bytes identical |
| K5 rescued | a caught canonical failure is not recorded as raised | CX — a handler that catches it turns it into silence | bytes identical |
| K6 unheld | a pending permission counts no wait | L2 — the element the request was asked inside does not read as waiting | bytes identical |
| K7 collapsed | only the last call of a repeated element is read | S4 — the earlier call is not on the screen | bytes identical |
| K8 unindented | a continuation starts at the margin | S2 — the rows of one line no longer begin at one column | bytes identical |
| K9 early liveness | the entry says it is not live before releasing what it held | L3 — the installation is released into a session that already called itself finished | bytes identical |
| K10 narrow empty | a narrow frame routed to Entries shows no reading | UI13 — the 72×20 frame places no reading row | bytes identical |
| K11 foreign | a terminal carries a request its invocation did not issue | CX1 — another element's body runs on the invalid delegation | bytes identical |
| K12 mutable phase | a published phase is not frozen | CX3 — a reader rewrites the terminal observation | bytes identical |
| K13 envelope | the lexical envelope disagrees with the extractor | SI2 — the offsets differ and `parseSource` would refuse | bytes identical |
| K1b exit rail | an exiting element takes the unobserved rail | S4 — the rail is not the archive's `exit` literal | bytes identical |
| K14 preview clipped | a question preview takes one row per logical line | F3 — `drawer:message:4` is wider than the drawer it was measured for | bytes identical |
| K15 badge adrift | the badge pad is three columns short | P1-T3 — the badge's last cell is at 121, not the interior's 124 | bytes identical |
| K16 twice badged | every row of a delimiter carries its badge | P1-T3 — two rows say `● ACTIVE` where one element is expanding | bytes identical |

All seventeen break; none is vacuous — K1 and K14 did not, until the assertions
they needed were written. Both gaps were found by making the control honest
rather than by reading the code.

**A self-audit from that pattern.** Twice a control was vacuous because the
assertion read the model where the claim was about the screen. Badge alignment
had the same shape: "aligned at the measured source pane's right inner edge" is
frozen, and everything checking it read the composed run strings — this
terminal's own answer about itself. P1-T3 now commits a frame with one observed
element, finds the row that says `● ACTIVE`, and asserts its last cell is the
transcript interior's last cell, in the archive's literal, with the source
beside it keeping its own colours. It also asserts that every reading row
opens with its rail in cells, and that exactly one row says the badge.
**K15** and **K16** are their controls.

K16 came back **UNBROKEN** first: putting the badge on every row of a
delimiter broke nothing, because the fixture's tag fitted on one row — a rule
about continuation rows cannot be tested by an element that has none. That is
the third vacuous control this slice produced, all the same shape: an
assertion that cannot reach the thing it claims. Each was found by making the
control honest, never by reading the code. The one-bit palette control is PR 1's own
record and returns in the assembled PR 3 evidence.

## The gallery

`pr2-evidence/` — **44 pairs**: the fourteen frozen states at 160×36, 120×30 and
72×20, plus `question-resize-refused-60x15` and
`question-resize-recovered-160x36`. Captured from this unchanged head in one
continuous journey against the real Deno entrypoint, terminal adapter, input
decoder, mounted tree and TTY renderer, in a private tmux PTY. Every state is
reached by normalized input and real operations; nothing is injected. Each
window is moved with that window's own control, in the pane that owns it.

  - `captures/` — the raw ANSI and plain text of each screen
  - `pairs/` — each production screen beneath the archive study it is compared
    against, per `final-gallery-matrix.md`'s mapping
  - `sheets/` — 16 contact sheets, one state across its three profiles
  - `comparison.html` — the whole gallery
  - `gallery-manifest.json`, `actions.jsonl`, `provider.jsonl`, `run.log`
  - `cold-before.json` / `cold-after.json` / `cold-command.txt`
  - `sha256sums.txt` — 317 files

**Cold counters.** Reopening the settled head at
`xmd://repl/07d87025c2ca24f68cc33ff746060551/entries` left the Journal at 49 022
bytes and the provider log at 8 014 bytes, both with the same SHA-256 before and
after: the cold read appended nothing and called nobody.

## C2, C3 and C4, row by row

The first handback said these were partly covered and the second said C3 and C4
were complete while quietly dropping C2. Both statements were wrong about
something. Here is each frozen clause and the case that decides it, in
`component-expansion.test.ts` unless named otherwise.

| C2 clause | Case |
| --- | --- |
| Import returns with body held | an import that returned is not an element that finished — entered, active, nothing terminal, while the body is held |
| Body returns with cleanup held | a body that has returned stays in EXIT while its cleanup runs |
| Early resolution / props refusal | an element that resolves to nothing is never active, and still completes |
| Return validation fails | a return the schema refuses is reported as content and completes `Ok` |
| Printed failure | a body whose component prints its own errors does the same |
| Recovered child | recovering a child's failure does not fail the parent, with the unrecovered case beside it |
| Full dispatch middleware cleanup held | COMPLETE follows the whole dispatch: a subscription on the handler's own frame never sees it, one on an outliving owner does |

| C3 clause | Case |
| --- | --- |
| Body and teardown failures | a body that throws exits failed with a detached report; cleanup that fails completes the element with a failure |
| Clean wait cancellation | clean cancellation publishes CANCELLED after unwind |
| Cancelled cleanup failure | an actual cleanup failure publishes a failed COMPLETE instead |
| Fatal/cause precedence, reporting detachment | catching a canonical failure does not rescue it (control **K5**); the report is a frozen detached `Error` with no identity reachable through it |
| Compare observed/unobserved output, bindings, failure, Journal bytes | an observed run and an unobserved one serialize identically — same elements, identities, positions and rendered result |

| C4 clause | Case |
| --- | --- |
| Two readers | two readers of one element each get the whole sequence |
| Slow reader | a reader that takes one phase and stops delays nothing |
| Absent reader | a reader that never reads delays nothing |
| Cancelled reader | a reader whose scope is cancelled mid-expansion cancels nothing |
| Late terminal reader | a late subscriber is told where it is, without earlier replay |
| Ordered latest registration, one terminal then void | each reader registers with the latest phase and is then told each change in order |
| Execution never awaits a frame | every case above renders and completes with no frame in the run |

Two of these were first written as guesses and were backwards — the product
completes a *printed* failure `Ok`, and the drain order of an asynchronous
consumer cannot witness a publication order. A probe against the real engine
replaced both.

**L1–L3** are decided in `repl-lifecycle.test.ts` and
`repl-agent-execution.test.ts`. L3's ordering clause — held installation and
outer release precede `live = false` and the ready wake, with no input — is
observed by an installation that reads what the session was still saying about
itself at the moment it was released (control **K9**), not read off the comment
that states it.

## A claim this handback withdraws

The last version reported that a *fence*-admitted generated fragment's source
is not substituted. **There is no such fragment.**
`packages/core/src/components/Evaluate.ts` is the only caller of the
generated-XMD admission, so `<Evaluate>` is the only element that makes one and
the frozen rule covers every admission that exists. The earlier reasoning
confused a fence that *computed* a fragment's text with one that admitted it —
in the reference entry the fence computes `summarySource` and
`<Evaluate text={summarySource} />` admits it, which is the paired case S1
already covers. Withdrawn, not explained.

## The narrow outlet, which was the last open claim

The previous handback left 72×20 showing only the catalog and called it the
frozen rule. It was not. The matrix routes every PR 2 scene to `entries` at
narrow and requires the scene to be captured there, so a narrow capture holding
nothing of the scene is the claim unmet, not the claim satisfied.

The Entries surface is the catalog **and** the reading of the entry it has
selected — the same two things the sidebar and the transcript are at a wider
size. A narrow frame has one column for both, so both are in it: the catalog
takes its own height while it fits and its share when it does not, which is the
rule the sidebar already uses, and the reading takes what is left.

Nothing about routing moved. Which surface a narrow frame shows is still the
route's and the footer still keeps its seven rows; what changed is that the
outlet shows what the surface *is*. The narrow captures now carry Output,
Source, the rails and the badges — `nested-running-72x20` has `● ACTIVE`
against the pane's right inner edge at 72 columns, and `failed-72x20` has
`No rendered output.`, the outcome and the recorded reason.

Two assertions moved with it, both named in the commit: `UI13`'s narrow leg
asserted that no reading row is placed at this size, which is the premise this
replaces — it now asserts placement at all three profiles, in whichever region
the profile has for it. And `TL6` skips a covered line that is only a window
control's label, because the outlet and the drawer spell `[↑ earlier]` the same
way: finding one inside the drawer's rectangle says the drawer has its own, not
that something behind it showed through. Control **K10** keeps the first
honest.

## The accepted eight-step journey, and where each step is answered

The journey in `pr2-product-verification.md` is the **Planner's** to walk, and
walking it is how this slice gets a verdict — that has not happened and is not
claimed. What is here is the evidence it can be walked against: the gallery
journey drives the same Plan-to-README story through the real command, so every
accepted step is either captured at all three profiles or asserted by the run.
The mapping, so the Planner reads rather than re-runs:

| Step | Captures | What they show of it |
| --- | --- | --- |
| 1. Submit; Evaluate containing Plan; rails; full-word statuses right-aligned; an import alone is not SETTLED | `nested-running-{160x36,120x30,72x20}` | both elements reading `● ACTIVE` against the right inner edge, rails running opening to closing, nothing settled |
| 2. Open the Plan review; reach its preview and decisions with the arrow controls; close and reopen, still WAITING | `plan-review-*`, `plan-review-controls-*` | the drawer, and its decisions reached with `[↓ later]`. The close-and-reopen half is now **asserted by the journey** rather than captured: it reads the source with the drawer shut, dismisses the drawer, checks the question is still being offered, and fails if the source moved. No scene is added for it — the list is frozen at 44 |
| 3. Approve; the generated heading and first Elicit replace Evaluate's inner producer; its tags remain | `generated-inline-*` | the admitted program inside the author's own `<Evaluate>` enclosure, the producer gone |
| 4. Empty values, then Northstar; at 72×20 reach the schema's closing delimiters and every decision control; wrapping keeps text and colours; continuations add no badge | `invalid-details-*`, `completed-details-*` | the validation, the populated form. The 72×20 reach is in `readme-preview-tail-72x20` |
| 5. Read the whole preview, approve; settled entry from its first window — Output before Source, beginning with the rendered document; reach `README.md was created.`; the write happens once | `readme-preview-tail-*`, `settled-output-first-*`, `settled-output-last-*`, `settled-source-*` | the four states in order, from the reading's own window |
| 6. Inspect a prefix from before admission — Plan again, no future text, no live badges; advance offscreen; return live | `historical-before-admission-*`, `returned-live-*` | the retained producer with unobserved rails, and the live head afterwards. The offscreen advance is now **asserted by the journey**: a second Plan entry is held at the provider's gate, an earlier prefix is inspected while it runs, the gate is opened with nothing typed and nothing activated, the prefix is checked not to have moved, and returning live is checked to show the advanced head |
| 7. Resize through the profiles while reading wrapped content; the status column stays inside the pane and its reservation is stable | every scene at three profiles, plus `question-resize-refused-60x15` and `question-resize-recovered-160x36` | the refusal below the minimum and the same question with its values after recovery |
| 8. Cold-open the settled entry **and the earlier retained prefix**; same retained source and output, no live badges, no provider activity, no Journal mutation | `cold-settled-*`, `cold-before.json`, `cold-after.json`, `cold-after-historical.json`, `cold-command.txt` | the reopened head; then the same cold process reading a position from before the generated admission, **asserted** to show the producer and neither generated text nor a live badge. The Journal and the provider log are identical SHA for SHA across *both* reads |

All eight steps now have evidence. Three of them — step 2's close-and-reopen,
step 6's offscreen advance and step 8's cold open of the earlier prefix — are
**assertions the journey makes**, not scenes: the list is frozen at 44 and these
are things a journey does, not states a gallery holds. The run fails if any of
them is false.

Getting them right took several corrections worth recording, because each was a
harness error that would have read as a product defect:

  - a pane sliced from the "Transcript" heading rightwards is the *drawer* while
    one is open, not the reading behind it;
  - the guidance row above the reading changes when focus does, and the status
    column beside it changes while work moves — neither is the source, and both
    had to leave the comparison;
  - a retained position refuses a submission, so an offscreen advance has to be
    work already in flight rather than something typed from the frozen view;
  - a frozen position cannot report the head moving — that is what it is for —
    so the advance is observed after returning live, not during;
  - `exit_location` took the first location in the pane's scrollback, which
    after several sessions is a stale one.

One of those corrections produced a real finding and then retired it. With the
offscreen stage running *before* the cold read, the provider log grew by 450
bytes across the cold reopen — which would have been a violation of step 8's
"no provider activity". The cause was my own harness: it left an entry
unfinished, and a cold process reopening one reconnects its provider. Moving
the stage after the cold evidence restores the true reading, and both counters
are now byte-identical across both cold reads. The frozen claim holds; the
earlier number was the harness measuring its own leftovers.

## The architecture review

`pr2-architecture-review.md`, against the seven frozen structural checks in
`pr2-planner-handoff.md`. All seven are met, each naming the test or control
that would fail if it were not.

It is written by the Implementor, because the handoff asks the Implementor for
it — "return ... all review/control/cold evidence", and "the architecture
review uses the seven frozen checks in pr2-planner-handoff.md; it adds no
speculative permutation". It says so in its own opening rather than pretending
otherwise: authorship is mine, confirmation is not, and an author reviewing
himself finds what he was already looking for. Every "met" in it is a claim
with its evidence attached, for the Planner to confirm or reject.

I withdrew this file for two turns, renamed to a "self-assessment", on the
reading that a review by the author is no review. That was an over-correction:
the complaint it answered was that the review had not been *confirmed* by the
Planner, which is a Planner action and not a reason the deliverable should not
exist. It is restored.

Its renderer note was wrong and has been removed: see the correction above.

## What is not done, and is not mine to do

The handoff's next action for me is to implement the ordered layers and return
focused feedback. That is what this is. Two things remain, and both belong to the
Planner:

  - the **Planner's** walk of the accepted eight-step journey at all three
    profiles — mapped above, with every step now answered by a capture or an
    assertion, but a verdict on it is theirs and not in this packet;
  - the **Planner's** acceptance or request for changes on this slice.

Nothing in this handback is claimed as #881 parity, and neither of those two
has happened.

Next action: the Planner re-reviews R4 at `acadbbdb`, and completes the live
journey steps its own run could not reach.
