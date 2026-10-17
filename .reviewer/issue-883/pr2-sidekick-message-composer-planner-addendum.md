# Wrap and grow the Message Sidekick field

**Approved guidance/padding amendment:** execute
[the latest resolution](pr2-guidance-padding-planner-amendment.md) too.
It resolves the width/guidance conflict through measured wrapped body text
and adds two-cell horizontal padding around Sidekick chat/composer/body controls.
Measure value and chat against that padded inner width; retain the existing
six-row cap and outer-width table. MC5–MC7/PW1–PW2/G1/P1 share the same three
feedback commands. Preserve all in-flight work and resume implementation.

**Accepted width amendment:** also execute
[the released width addendum](pr2-sidekick-pane-width-planner-addendum.md).
It gives Transcript/right equal shares after the sidebar, keeps the odd cell
with Transcript, and adds PW1–PW2. Preserve the currently in-flight composer
work and return one combined feedback commit.

**Released, 2026-10-15.** The Product Owner answered **yes** to six visible text
lines, then internal scrolling, with fewer lines on small screens. Execute
[the Implementor prompt](pr2-sidekick-message-composer-implementor-prompt.md)
from accepted signed clean 25227d38. No product or architecture question remains
pending for this slice.

Message Sidekick wraps at its measured width and grows as you type. Its label
stays visible, its edited end stays in view, and Send carries the original text.
The shared Draft and other fields keep their existing behavior.

## Accepted base and source finding

- SHA: `25227d38cb8087743cd404533c7960de9423a442`.
- Parent: `13c4900dbf0c4e57411241ada84aa00f4b55ba65`.
- Branch agent/issue-883-pr2; signature G / tarasm@gmail.com.
- Worktree: /Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2.
- At this plan's original release, independently clean with nothing untracked.
  Composer edits are now in flight; the width addendum records that current
  state. Preserve them.

[The closing review](pr2-sidekick-responsiveness-planner-review-25227d38.md)
accepts terminal, chat and responsiveness work. All earlier owner, admission,
recovery, questions, Configure, Preview, Sessions and Core/ACP behavior stays
accepted. Preserve this head and all ancestors; no amend/reset/rebase or
unrelated main edits.

The existing field explains both reported defects: sidekickControls describes
one FIELD; fieldParts splits on newlines and displays only the last one behind
an earlier-line count; rowProps reserves one row. That shared policy also serves
Draft and drawer fields. This change deliberately applies to Message Sidekick,
not to every FIELD. This is source evidence, not a claimed mounted reproduction.

## Settled behavior

The label and existing focus marker sit above the value. This gives the value
the pane's measured content width and keeps its name visible during internal
scrolling. The label is one fixed row; the six-row cap counts **value text only**.
An empty value occupies one blank row. For example, with the field focused:

```text
>> Message Sidekick:
Write a question whose words wrap
onto another row.
[send]
```

This illustrates placement, not a fixed wrap width. Actual cuts come from the
engine. Keep the exact Message Sidekick name and existing focus-marker meaning.

Fit literal value text, preserving whitespace, explicit pasted newlines and
blank lines. Prefer word boundaries and split long words only at grapheme
boundaries using the existing engine width answers. Soft wrapping is display
only: it inserts no newline into the original editing/submission string.

The block keeps sidekick:message as its single field identity, editing value
and focus owner. Continuation rows add no Tab stops. Typing and Backspace edit
that value; Enter and [send] still send. Existing pasted newline/Control-J
input remains. No new editor navigation, shortcut or scroll control is added.

### Height and small-screen bound

The composer grows upward within its pane. The footer remains seven rows.
Tabs, fixed announcement/control rows, Send/Stop and at least one chat row stay
reachable.

Measure the frame with its actual fixed controls, the label and **one** value
row. Let C be that minimum-composer frame's measured chat viewport capacity.
The maximum value height is min(6, C): growing to h value rows removes h - 1
chat rows, leaving C - (h - 1), which must remain at least one. Use the smaller
of the fitted value row count and that maximum; empty text counts as one.

Use the actual measured frame, including working/question announcements,
rather than guessed profile rectangles. Normal drawable states must leave
C at least one. If they cannot, return a concrete layout conflict rather than
hiding controls or changing the minimum drawable profile.

Once capped, show the last h fitted value rows. Older rows stay in the original
message, and the editing end stays visible. Backspace can shrink the fitted
value and the box again. The name remains above these rows. The cap may decrease
on a smaller screen or when fixed controls need more room.

Chat admission uses the resulting composer height. A following chat keeps its
latest rows at the bottom as capacity shrinks; a deliberate reading keeps its
own starting place subject to existing clamping. Existing per-chat reading
state and explicit Sessions reveal priority remain intact.

### Ownership and Send

Growth, wrapping, shrinking and resize submit nothing and change neither Draft
nor selected chat, focus or question state. The message stays editable while
Sidekick works. Busy Send refuses as before; Stop joins its existing owner.
Older chats remain read-only without this composer.

Send captures the original string once. An acknowledged Send clears only the
captured message revision and shrinks that cleared value to one blank row.
A newer edit made while its append is held keeps its text and current height.
No durable record, URL value or stored message is rewritten for visual wrapping.

## Implementation in order

1. Prepare the original message as engine-fitted value rows at the measured
   content width. Keep the original string as the sole editing/submission value.
   Wrapping and vertical slicing produce detached display data.
2. Carry the label, visible value rows and height through the existing component
   and box construction under one field node. Other FIELD consumers keep their
   one-row path. Measurement and commit use the same prepared height.
3. Measure the minimum composer to obtain C, select the bounded height, and
   admit chat rows against that final capacity. One prepared chat list still
   supplies descriptions, row counts, scrolling and Sessions reveal.
4. Adapt mounted field readers and assertions for label-above-value placement,
   preserving their claims. A helper reads visible rows; it must not claim to
   recover hidden bytes from the screen. Read retained text when asserting the
   complete sent value.
5. Add MC5–MC7 below, align architecture.md and specs/repl-spec.md, and run the
   focused commands. Commit when the evidence passes.

Source scope is application.ts, program.ts, fitting.ts, layout.ts and
components/rows.ts only as needed for this message-specific path. Ordinary
private mechanics and helper names are delegated. Reuse existing fitting,
frame measurement, input routing and revision acknowledgement. Do not enlarge
the global row height, replace the renderer, weaken validation, add a second
focus store, or change journal/route/provider interfaces.

The accepted chat cache still reuses unchanged chat lines when only composer
text or height changes. Width changes invalidate fits. Do not settle composer
lines into the chat store: that would evict the chat on every key. If retaining
composer cuts, give them separate command-owned storage through the existing
plain-fit mechanism.

## Frozen evidence: MC5–MC7

Use the existing mounted fixture and repl-sidekick-presentation.test.ts.
No second terminal host, new scenario matrix or mutation battery is assigned.

| Row | Required observations |
| --- | --- |
| MC5 — wrap and grow | With a populated following chat, type past one measured value line and paste text containing a newline, blank line and wide/combining character. Observe disjoint composer rows, smaller measured chat capacity and the latest chat row still at the bottom. Label, controls and seven-row footer remain intact. Backspace over trailing ordinary text shrinks the composer without touching Draft. Preserve the accepted deliberate-reading cases. |
| MC6 — cap and Send | At 160x36 grow beyond six fitted value rows: exactly six remain visible beneath the fixed label, including the editing tail. Send retains/prompts with the original literal string once, including whitespace/newlines. Ordinary acknowledgement returns to one blank value row. Pair with a newer wrapped edit behind a held message append: that edit and its current height survive. Reuse the existing acknowledgement harness. |
| MC7 — resize and busy | One journey across 160x36, 120x30, explicit Sidekick at 72x20 and 60x15 refusal/recovery: value and focus survive, cuts/height use current measurements, Send/Stop and at least one chat row remain reachable. Assert the reduced cap where C < 6 using the minimum-composer measurement. Hold generation, edit the field and show growth without sending or modifying the in-flight request. A tab round trip preserves its text. |

Preserve RS2–RS5 and the acknowledgement, independent-form, read-only and Stop
claims. RS3's Message display assertion now reads the value block rather than
expects label and value on one row. Its short/long unchanged chat work remains
equal for the same composer edit; the composer's own fitting is real work, so
the old absolute render count is not a product invariant.

Previously preserved external probes describe the old one-row composer. Do
not rewrite historical probes or require their inline label/value observations
to pass under this intentional presentation change. Permanent mounted rows and
the focused selections below govern this increment. Report every adaptation.

## Focused commands and feedback

Run these exact three selections from the implementation worktree:

```sh
deno task test packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts packages/cli/tests/repl-presentation-style.test.ts
deno task test packages/cli/tests/repl-sidekick-configuration.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-forms.test.ts
deno task test packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-agent-journey.test.ts packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-source-reading.test.ts
```

The first proves MC5–MC7, retained fitting, mounted geometry and owner/drawer
lifetimes. The second covers acknowledgement and other FIELD consumers. The
third covers ordinary entry interaction, shared layout, source fitting and
lifecycle. The width amendment adds source-reading to that selection. This is
feedback evidence, not delivery verification.

Preserve first failures. No broad lint/check/JSR, complete runtime suite,
dependency/cache/lock change, flake repair, push, GitHub write, CI inspection
or capture is added. Previously recorded flakes and review PTY limitations
remain separate. Do not weaken their assertions.

Continue through the finite implementation and evidence without stopping at
progress checkpoints. Give brief progress updates; stop early only for a
concrete contract conflict or missing required authorization. Once evidence
passes, commit promptly with repository signing. Return exact SHA/parent,
branch/signature/clean state, every command/result, MC5–MC7 mapping and every
fixture/assertion adaptation. Stop for review of that exact commit.

## Continuity

Base: accepted signed clean 25227d38, parent 13c4900d. Produced: this released
addendum and its linked Implementor prompt. Settled: six visible value rows,
measured reduction preserving controls/one chat row, tail scrolling,
message-only wrapping, literal Send text and one field owner. No unresolved
product or architecture decision remains. Next Implementor action: execute
this slice and return one signed feedback commit. Prior acceptances stay closed.
Teaching, the 36-frame packet and delivery remain separate. This planning task
changes no production source and adds no commit, push, GitHub mutation, CI or
capture.
