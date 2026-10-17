# PR 3 Planner review: request changes

**REQUEST CHANGES at f509197bd1998b376b09986b79fce2740568e76f.** The measured
History rail and category drawer are substantially in place. Four existing
frozen requirements remain unmet: the root's coherent retained reading, paused
offscreen advancement, the real-invocation lifecycle control, and proof that
same-category grouped actions select different content prefixes.

This is independent Planner feedback against
[the frozen implementation handoff](pr3-implementation-handoff.md), its H1–H6
matrix, [the seven structural checks](pr3-planner-handoff.md#frozen-structural-review-checklist),
and [the accepted product journey](pr3-product-verification.md). It adds no
production scope, persistence, public API, gallery scene or CI gate.

## Reviewed revision and evidence

Branch `agent/issue-881-pr3`, worktree `.claude/worktrees/issue-881-pr3`, accepted
base **acadbbdb4fa7d8c8c86fa85f6657d29c5d95bc3e**. Product HEAD remained
**f509197bd1998b376b09986b79fce2740568e76f** throughout this review. Three capture
fixtures are staged additions, absent from that commit; their index/worktree
bytes and hashes are retained in
[capture-fixture-provenance.json](pr3-planner-review-evidence/capture-fixture-provenance.json).
The review distinguishes that product revision from its uncommitted capture
inputs. I did not attempt authentication, bypass signing, commit, push, open a
PR or inspect CI. Unlocking 1Password requires the user's local authentication.

I independently ran both frozen commands, each with exit 0:

```sh
deno task test packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-model.test.ts packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-composition.test.ts packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-journey.test.ts
# 97 passed / 308 steps / 0 failed

deno task test packages/cli/tests/repl-source-reading.test.ts packages/cli/tests/repl-forms.test.ts packages/cli/tests/repl-agent-journey.test.ts
# 19 passed / 111 steps / 0 failed

git diff --check acadbbdb4fa7d8c8c86fa85f6657d29c5d95bc3e..f509197bd1998b376b09986b79fce2740568e76f
git diff --cached --check
# both exit 0
```

Logs are [main](pr3-planner-review-evidence/focused-main.log) and
[companion](pr3-planner-review-evidence/focused-companion.log). All 545 supplied
checksums matched at the start and end. I opened all 27 contact sheets, covering
all 77 pairs; [the per-sheet record](pr3-planner-review-evidence/gallery-review.json)
names them. The rail hierarchy, separate shared-column indicators, category
rows, drawer bounds, resize recovery, source colours and cold prefix reading
are visually consistent with the accepted adaptations. The offscreen scene is
the exception described in R2.

The supplied audit also exits 0 when replayed on copied capture text: 77 checked,
76 with the band, 70 with a rail mark. Its offscreen claim omits the required
held head, so that green result does not establish the frozen matrix. I inspected
the five control records and first-failure excerpts rather than rerunning mutations.
All five current production files match both recorded restoration hashes;
[restoration checks](pr3-planner-review-evidence/control-restorations.json) are
retained. KC3's claimed boundary is not the boundary its failing tests exercise.
The three supplied cold reports are byte-identical. H6's independently green
journey also exercises no source load or compilation during settled inspection.

## R1 — Rebuild the root reading from one snapshot and propagate full refusal

**Frozen basis:** implementation handoff section 1, H1/H2, structural checks 1
and 5. The handoff explicitly requires replacing program.ts's selected-only
shortcut, projecting full navigation and requested content from one retained
array, and carrying that immutable reading through paint and resize. A malformed
later segment uses the existing refused view.

That root change is absent. In `program.ts:774–787`, `reproject()` still returns
without reading when route and model selections match. Otherwise it independently
calls `execution.stream.readAll()` and projects only the requested content.
Navigation comes from `current.navigation` at `program.ts:667/682` and is read
again by `build()` at line 821. The intervening `screen.size()` and frame
preparation suspend. A retained append can therefore move navigation while the
selected model belongs to another snapshot. This is a structural finding from
the actual root path; I am not claiming to have captured that race in a PTY.

The new session projection at `session.ts:510` does project two models from one
array, but its selection is the opening option, not the root's changing route.
It cannot make the independently projected root content and freshly read
navigation one prepared reading. Its failure path is also incomplete:
`refuse()` at line 451 only answers an unresolved opening. Once admission has
answered, a later projection failure leaves the old model and points in place
and publishes no refusal. Root reprojection errors retain the old model with a
route notice instead of showing the full refused view.

A [focused probe](pr3-planner-review-evidence/admitted-malformed-probe.mjs)
executes a real Json entry, then appends a duplicate of its real final Close.
This is a malformed sequence of real event data. Both the full projector at the
early marker and a cold reopen refuse it. The admitted session still exposes
its identical old model, identical navigation and old prefix payload, with head
`settled`. [Output](pr3-planner-review-evidence/admitted-malformed-probe.log)
records those observations. The probe checks session data, not rendered cells.

**Required revision:** implement the already-frozen root snapshot flow. Bind full
navigation, selected content and retained head facts to the same acknowledged
array and reuse that prepared reading during paint/resize. Preserve the existing
live observation/capability suppression while inspecting. Propagate later full
validation failure to the existing refused view; preserve invalid-route-marker
refusal semantics separately. Add discriminating root-drive regressions for a
retained/session wake during inspection and for a malformed later segment after
admission. The cold-only session test is useful but does not reach this boundary.
Keep the documentation's one-snapshot claim aligned with the implementation.

## R2 — Prove advancement while expansion remains paused

**Subsequent Planner evidence correction:** [R2 now uses the supported
PAUSING → advance → PAUSED order](pr3-r2-evidence-correction.md). This supersedes
the establish-before-release recipe below. The historical REQUEST CHANGES
verdict at f509197b and the finding against its LIVE offscreen scene remain.

**Frozen basis:** H3, product journey steps 2–3, and the existing
`offscreen-advance` gallery row's “actual navigation append, same exact
selection/prefix and held head.”

All three supplied offscreen captures show **HEAD · LIVE**. In `journey.py:639`,
`stage_offscreen()` opens or starts Plan work, selects Entry 1, releases the Plan
provider gate and compares the prefix and selection caption. It never requests
Pause or establishes an expansion hold. Journal line growth proves an append,
but not that navigation updates while a real pause remains established. The
audit's offscreen row checks `[live]` and the selected caption and permits LIVE.
The separate paused-historical captures establish a real pause, but do not
perform the subsequent background append under that hold.

The focused H3 additions do not fill this gap: their pausing/paused cases feed
booleans to `headOf`; the real-session cases cover empty/live/settling/settled.
The neutral-ending loop also repeats the identical facts for three unused
strings instead of reading separate retained endings.

**Required revision:** use the already-frozen sibling work/expansion boundary:
start background work, request real Pause, establish the controller hold,
inspect an early prefix, then release work that already started. Assert a real
new retained checkpoint, growth of the full navigation list, unchanged exact
selected content, and the still-paused head. Closing History must leave the
hold in place. Return live, Continue and finish through the actual controller.
Capture the corrected offscreen state at the same three profiles and make the
audit require its held head. Finish the existing H3 companion evidence with
separate retained success/failure/cancellation inputs and an unowned unfinished
reading; do not count the unused-string loop as that evidence.

The controlled settling host is an acceptable implementation of the frozen
cleanup fixture. Its journey checks SETTLING, submission refusal and release to
SETTLED without input. There is no finding against that evidence, and no need
to replace ordinary CLI Pause scenes that already establish the required state.

## R3 — Make KC3 fail a frame from a real held invocation

**Frozen basis:** the five-control table explicitly requires removal of lifecycle
words/glyphs to fail a **real held-call frame**.

KC3 reports BROKEN, but its named WAITING and EXIT assertions are presentation
unit cases. At `repl-source-reading.test.ts:660/676`, each calls `entryReading`
with `observing([...])` data containing an assigned phase and waiting reason.
No invocation starts or waits. Its other named presentation case likewise
supplies observation data before rendering. These tests discriminate badge
formatting; they do not establish that a held operation reaches the assembled
frame. Calling them real held-call frames overstates the evidence.

The control runner also discards the captured process output and retains only
an excerpt, stopping before stack locations or after 1,400 characters. The
packet contains those JSON excerpts, not complete first-failure logs. The
from/to mutations identify the patches, but do not replace the prescribed
first-output records.

**Required revision:** retain those unit tests, and run the existing KC3 mutation
against a committed-cell assertion driven by an actual session-owned held
invocation through production composition. Observe the real wait or cleanup
boundary and assert its glyph/word on that invocation's source row against the
independent reference literals. Record the command, complete first failure and
SHA-verified restoration. Retain complete first-failure output and the mutation
patch for each of the same five controls on the revision. This repairs one of
the existing five controls; it adds no sixth control or new lifecycle design.

## R4 — Check the content selected by grouped actions

**Frozen basis:** H1 and product journey step 4 require separate exact prefixes
for two same-category checkpoints sharing one visual group.

`repl-history.test.ts:493` checks that a one-column group retains two member
markers, without selecting either. H5's root journey clicks a row and checks
only that history mode opens; its small checkpoint list does not crowd the rail.
The supplied crowded journey selects rows 2 and 3 and checks only that their
selection captions differ. Those rows are different categories, and a changing
caption could coexist with unchanged or incorrectly rounded content.

The [Planner's retained-prefix probe](pr3-planner-review-evidence/crowded-prefix-probe.mjs)
provides a concrete case from the supplied cold snapshot. Positions 28 and 29
are both component admissions, with markers `entry-5:yield:root:12` and
`entry-5:yield:root:13`. They share a measured group at all three profiles.
Their exact prefixes admit **11 versus 12 HistoryRecord component scopes**.
[Output](pr3-planner-review-evidence/crowded-prefix-probe.log) records the engine
measurements and prefix counts. This probe establishes the fixture and oracle;
it does not exercise drawer actions and is not claimed as the missing UI proof.

**Required revision:** select such a confirmed same-category pair through the
root drawer actions and check each exact route marker plus the content the
prefix actually admits. For the supplied pair, traverse the Entries windows
and verify the 11-versus-12 admitted component rows, retaining the full later
navigation in both readings. Also select a later marker directly while
inspecting. On a revised fixture, record the equivalent measured pair and its
expected admitted-content difference. Caption changes and group membership
alone are insufficient. No new gallery state is needed; this completes the
existing grouped-history journey and H1 regression.

## Planner fixture correction and seven-check disposition

The original crowd recipe was wrong. Multiple Json invocations can publish in
one binding record, yielding one binding checkpoint. Two hundred actual
HistoryRecord Markdown invocations supply the needed real scope checkpoints.
That substitution is accepted. The handoff's H1 case now calls for two
same-category component-admission markers instead of two binding markers; the
same exact-prefix invariant remains. The shared fixture record is corrected.
Authored root source already admitted at both markers is not future payload:
the discriminator is the component content admitted between the two markers.

| Frozen structural check | Disposition |
| --- | --- |
| 1 Authoritative retained identity | Unmet: R1; grouped exact-action evidence also outstanding in R4. |
| 2 Inspection reachability | The thin detached marker/kind shape and category wording are correct; root coherent-prefix verification remains subject to R1/R4. |
| 3 Execution ownership | Owned-work head derivation and settling evidence are sound; paused background and retained-ending evidence remain in R2. |
| 4 Persistence and reconstruction | No persistence protocol change; focused cold reconstruction evidence passes. |
| 5 Root and child boundaries | Direct downward view data and upward typed marker actions remain; root retained-reading ownership is incomplete in R1. |
| 6 Mounted targets and measurement | Measured rail, mounted drawer/resize regressions and visual evidence pass their placement checks; exact grouped content action remains R4. |
| 7 Resource and concurrency boundaries | No new reader, polling clock or resource owner introduced; existing ownership paths remain. KC3 still owes its prescribed real-frame evidence. |

I have not completed the independent three-profile live product walk and do not
claim acceptance of that journey. The supplied frames already contradict its
paused offscreen step, so the next live walk must use the corrected sequence.
The green focused runs and visual review above are completed review work, not
a substitution for the remaining live verification.

## Ready-to-send revision prompt

Revise PR 3 from f509197bd1998b376b09986b79fce2740568e76f against R1–R4 above.
Implement the frozen root single-snapshot reading and full post-admission
refusal; prove paused background advancement with the actual controller; repair
KC3 to fail a real held-invocation frame; and prove distinct selected content
for a same-category grouped pair through root drawer actions. Use the accepted
HistoryRecord crowd correction. Keep the existing public APIs, persistence,
seven-row footer and original parity scope.

Run both unchanged frozen focused commands and the endpoint whitespace gate.
Commit the corrected source/tests and the three capture fixtures through the
normal signed workflow as soon as focused evidence passes. Return the exact
SHA, commands, first control failures/restorations, and the same fresh 77-pair
assembled packet from that final unchanged revision. Fix the offscreen audit
claim and report which accepted product steps the journey actually performs.
Do not add gallery scenes or controls. Stop before push or PR creation.

Continuity: PR 1 and PR 2 remain accepted at their recorded SHAs. PR 3 feedback
is REQUEST CHANGES at f509197b. Produced artifacts are this review, its
[checksummed evidence](pr3-planner-review-evidence/sha256sums.txt), and the two
fixture-wording corrections in the implementation handoff and shared stack
record. Next Implementor action is the revision prompt above. The Planner's
remaining live walk and final accept-or-request-changes follow that handback.
