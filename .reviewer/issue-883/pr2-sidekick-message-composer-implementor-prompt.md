# Implementor assignment: wrap and grow Message Sidekick

**Conflict resolved; padding added:** the Product Owner approved wrapping body
guidance/refusal explanations and requested padding around Sidekick chat.
Execute [the released guidance/padding amendment](pr2-guidance-padding-planner-amendment.md)
with this prompt. It preserves the equal outer widths and six-row composer,
uses two horizontal cells on each side of the Sidekick body, and freezes G1/P1
within the existing three commands. Resume with all in-flight work preserved;
return one combined feedback commit. No further decision is pending.

**Width amendment released:** the Product Owner approved equal sharing after
the sidebar. Read and execute
[the width addendum](pr2-sidekick-pane-width-planner-addendum.md) with this
assignment: 64/64 Transcript/right at 160x36, 46/46 at 120x30, and any odd spare
cell to Transcript. Preserve in-flight composer work and return one combined
feedback commit. PW1–PW2 and the updated third command are included; no width
decision is pending.

Follow .agents/implementor.md and execute
[the released composer plan](pr2-sidekick-message-composer-planner-addendum.md)
in full. The Product Owner approved six visible text lines, then internal
scrolling, with fewer lines on small screens. No cap decision remains open.
Return one signed feedback commit after the finite evidence passes.

## Exact base

- Worktree: /Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2.
- Branch: agent/issue-883-pr2.
- SHA: `25227d38cb8087743cd404533c7960de9423a442`.
- Parent: `13c4900dbf0c4e57411241ada84aa00f4b55ba65`.
- Signature G / tarasm@gmail.com; the committed base was independently clean
  when the composer was released. The worktree now contains that in-flight
  composer work, recorded in the width addendum; preserve it.

Verify the actual head and tree first. Preserve all ancestors; no amend, reset,
rebase or unrelated main changes. If it has advanced, account for that work
without discarding it. The terminal/chat/responsiveness slice has
[PASS](pr2-sidekick-responsiveness-planner-review-25227d38.md). All previous
Core/ACP, owner, admission, recovery, question, Configure, Preview and Sessions
acceptances stay closed.

Read repository instructions, .agents/agent-writing.md and the affected REPL
specification/architecture. The released plan, width addendum and latest
guidance/padding amendment freeze behavior, source scope,
MC5–MC7/PW1–PW2/G1/P1 and the three exact feedback commands.

## Required behavior

Message Sidekick becomes one field block with its existing name/focus marker
above engine-fitted value rows. The label takes one row; an empty value takes
one blank row. The value grows to at most six rows, excluding the label, and
then automatically shows its newest rows. Original text and hidden rows remain
in the editing value. Soft wrapping inserts no newlines into Send's string.

Fit to the measured padded body width, preserving pasted newlines, blank lines,
whitespace and graphemes. Keep sidekick:message as one focusable field; do not
make continuation rows extra fields or Tab stops. Enter and [send] still send,
Backspace still edits, and existing newline input still works. No new editor
shortcuts or scroll controls are assigned.

For the small-screen cap, measure this frame with its real fixed controls,
the label and one value row. If that minimum-composer chat viewport has
capacity C, maximum value height is min(6, C). Adding h - 1 value rows then
leaves at least one chat row. Use the smaller of fitted value rows and that
maximum. Keep the seven-row footer, tabs, announcements and Send/Stop reachable.
Do not guess capacities from profile rectangles or hide controls to fit.
The plan specifies how to return a concrete conflict if a normal drawable
state cannot leave C at least one.

The measured composer height and committed height must agree. Measure widths
first; use the minimum-composer measurement to choose height and admit chat
against the resulting capacity. A bounded additional structural measurement
is allowed when needed for that final frame; no layout convergence loop or
fractional rounding. Following keeps the latest chat rows visible as capacity
shrinks; manual reading and Sessions reveal preserve their accepted behavior.

Send captures the original string exactly once. Acknowledgement clears only
its captured revision; newer wrapped edits and their height survive. Busy
editing remains allowed, busy Send refuses and Stop joins as before. Earlier
chats remain read-only. Resize, tab changes and refusal/recovery preserve text,
focus and the shared Draft.

## Implementation and evidence

Work in application.ts, program.ts, fitting.ts, layout.ts and components/rows.ts
only as needed for the message-specific presentation. Keep Draft and drawer
FIELD consumers on their current path. Preserve the renderer validator, field
ownership, journal/route schemas and provider interfaces.

Keep the accepted chat cache effective when only composer text or height
changes. Never settle composer lines into the chat store. Separate owned
storage through the existing mechanism is allowed for composer cuts.

Execute the plan's ordered steps and MC5–MC7, using the existing mounted host.
Update field readers/assertions mechanically for label-above-value placement;
preserve every original claim and report every adaptation. Visible readers
must not invent hidden input text. Align architecture.md and specs/repl-spec.md
with implemented behavior, including the six-row cap and measured reduction.

Run the width addendum's three exact selections against the final combined tree
(source-reading is added to the third). They cover the
new composer, existing input/form consumers, retained fitting, geometry and
lifecycles. Preserve RS2–RS5's work comparisons; a new composer's own fitting
need not preserve the former absolute count. Historical external probes that
assert inline label/value placement are not assigned or to be rewritten.

No new matrix, mutation battery, broad lint/check/JSR, full runtime suite,
dependency/cache/lock repair, flake repair, push, GitHub write, CI inspection or
capture is authorized. Teaching and the 36-frame packet remain separate.

## Feedback

Continue through implementation and the finite evidence without stopping at
progress checkpoints. Give concise updates while working. Stop early only for
a concrete contract conflict or missing required authorization.

When focused evidence passes, commit promptly with repository signing. Hand
back exact SHA/parent, branch/signature/clean state, all three command/results,
MC5–MC7/PW1–PW2/G1/P1 mapping, first failures and every fixture/assertion adaptation. Stop
for review of that exact commit.

Base: accepted 25227d38. Produced: this prompt and the released composer plan.
Settled: equal main-pane sharing with the odd cell to Transcript, wrapped body
explanations, two-cell Sidekick body padding, six visible value lines, measured
small-screen reduction, automatic internal scrolling, one field owner and
literal Send text. No unresolved
product or architecture question remains. Next action: implement this bounded
slice. Prior acceptances stay closed; delivery remains separate.
