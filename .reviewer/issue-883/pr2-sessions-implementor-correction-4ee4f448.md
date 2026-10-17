# Correct populated Sessions, chat identity and turn reveal

**Reviewed at 5ce2e2d2, 2026-10-15:** SS-P1–SS-P3 are closed and most SS-E1
evidence is accepted. Continue with
[the remaining evidence correction](pr2-sessions-implementor-correction-5ce2e2d2.md)
from signed clean 5ce2e2d2. [The review](pr2-sessions-planner-review-5ce2e2d2.md)
records what remains. The older instructions below are historical and do not
assign the three production fixes again.

Correct the Sessions slice from signed clean
`4ee4f44824ce39f41385e70cce107bd0d110ec6c`, parent
`10b17a40fb07eb2fe623c9b4e4a5259d0501fe9a`, branch agent/issue-883-pr2, in
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`.
Follow `.agents/implementor.md`. Verify the exact head/signature/tree, preserve
both commits and unrelated work, and reconcile advancement without reset,
amend or discard.

Read the main-checkout records in full:

- `.reviewer/issue-883/pr2-sessions-planner-review-4ee4f448.md`.
- `.reviewer/issue-883/pr2-section5-sessions-planner-handoff.md`.
- `.reviewer/issue-883/pr2-section5-sessions-architect-decision.md`.

The two-section architecture, actual provider filters, read-only old chats and
sidekick= boundary remain settled. Preview and earlier acceptances remain closed.
No new product or architecture interview is needed. Seven focused selections
and both unchanged Preview probes pass on the reviewed head; that does not
close the three reproduced defects or missing frozen observations below.

## Required corrections

1. **SS-P1:** keep a populated ordinary Sessions/chat frame valid. The real
   mounted Message/Send probe fails on its sixth short message at 160x36 with
   a fractional renderer row, y=24.0078125. Its one-message control passes.
   Correct the application measurement/layout connection while preserving
   whole controls, windowing, cell geometry and the footer. Do not round or
   weaken renderer validation, discard rows, patch vendored code or shrink the
   test. Promote the actual population regression and small-chat control into
   SS7's existing mounted destination.
2. **SS-P2:** scope the local incomplete-item alias to its exact conversation
   and saved turn. sidekickChatRows() now reads every chat, but the alias test
   still compares only the turn number. A current failure can give an older
   failed turn the same response key as that older chat's preceding reply.
   Preserve both items and their own identities; no deduplication, inferred
   response ordinal, durable mapping or history rewrite. Promote the paired
   canonical-composition regression and control and cover the supported old
   chat/current update path through the existing mounted journey.
3. **SS-P3:** reveal the selected actual turn using the destination chat's
   measured window. A narrow Sessions frame has no SIDEKICK_WINDOW; the current
   revealing() therefore returns offset zero. Retain the exact pending reveal
   as process-local root state until the destination measurement can place it.
   Land on the turn's own evaluated reply or inert turn anchor, not just the
   first person row carrying its number. Preserve History, filters, both texts,
   Freedom focus and route semantics. No durable scroll field, guessed rectangle
   or second focus store. Promote the measured regression/control and exercise
   off-window activation through the real mounted control in SS4/SS7.

Reproduce these three probes unchanged before editing; their current first
failure outputs already exist in the review packet. Run from the implementation
worktree using absolute main paths:

```sh
deno task test /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-sessions-populated-probe-4ee4f448.test.ts /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-sessions-cross-chat-probe-4ee4f448.test.ts /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-sessions-reveal-probe-4ee4f448.test.ts
```

The first probe is a real mounted command. The second is canonical-record pure
composition. The third is canonical projection through the real measured and
committed application pipeline and semantic reduction. Do not claim the pure
probes alone establish the mounted paths. Preserve their distinctions when
promoting them. The earlier diagnostic boundary-probe file is historical and
is not part of the correction commands.

## Complete SS-E1 without expanding the matrix

Finish these observations already specified in SS1–SS7:

- Actual row keys before/after canonical publication, including saved Prompt
  versus held evaluation and its later outcome; no-input cleared text and the
  distinct phase changes. Counts of matching titles alone prove no identity.
- Unknown-ID cold refusal over an unfinished entry, before it could resume;
  a real saved prepared/failed association with no provider key opens read-only
  and shows its actual setup status/reason. Merely supplying IDs to route
  availability or showing No messages yet does not establish that status.
- Stop before canonical append acknowledgement with an actually observed live
  key, no saved turn, retained local filter evidence and a cold refusal of the
  exclusively ephemeral key. The reviewed row releases the append before Stop
  and asserts none of those saved/cold distinctions. Use a cancellable hold at
  the owning operation boundary; report a real lifecycle conflict rather than
  releasing first and claiming the earlier boundary was tested.
- One entry turn and one Sidekick turn sharing a parsed provider key: one
  filter choice, both owner rows. The reviewed recovery row has one turn and
  a second empty chat; it supplies no same-key pair. The pure canonical case
  remains authorized for this evidence interpretation.
- A genuinely selected entry and a partial current question survive the visit
  to an older read-only chat. Observe absent controls, modal input and targets
  through the measured/mounted reading, not only visible substrings. Populate
  the three-profile navigation case, reveal an off-window old turn and keep
  Back reachable; do not call an explicitly selected active chat read-only.
- The accepted interrupted-first-message divergence reaches the new Sessions
  rows with distinct, stable identities. Reuse the existing real recovery/gap
  path; the unchanged Preview probes remain their own evidence. Read a real
  automatic feedback turn's inert anchor through selection where no evaluated
  reply was recorded; machine input stays off chat.

Keep the existing positive cold copied-location, prefix filtering and read-only
cases. Reuse existing owner/transport/file gates and fixtures; no second
terminal host, journal, provider subscriber or debug API. No sleep or fixed
scheduler count establishes readiness. Align the affected prose after fixes,
including actual setup status; preserve prior contracts and assertions.

## Evidence and feedback

The original three control results remain accepted, including the corrected
held automatic-follow-up begin witness. Repeat a control only if its connection
changes. The new probes' failing regressions and passing controls are the
required discrimination for these findings; no additional mutation battery is
assigned.

After restoring the final source, run all seven focused selections and both
unchanged Preview probes exactly as listed in the frozen plan, plus the three
probes above. Preserve first failures before fixes/reruns. Report adaptations
and each missing observation's new row. Existing L2/U2 flake records stay open;
an unchanged rerun does not fix their causes. Do not repair caches/dependencies
or unrelated lint. No full lint/check/JSR/runtime battery, CI or capture is a
feedback prerequisite.

Once this finite evidence passes, promptly create one new signed feedback
commit above 4ee4f448. Hand back exact SHA/parent, signature, tree/untracked
status, changed files, every command/result, SS-P1–SS-P3 and SS-E1 mapping,
controls and adaptations. Runs must describe the final committed tree.
Continue routine work without asking for another go-ahead between layers;
return only a concrete contract conflict or the signed feedback commit.

No new Core/ACP interface, journal version, provider routing, native permission
UI, generic framework, renderer validator change, push, GitHub mutation, CI
inspection, terminal capture, dependency change or shared-cache repair.
Sessions remains unaccepted until review; Preview and prior acceptances stay
closed. Complete terminal acceptance, the 36-frame packet and delivery remain
separate assignments.
