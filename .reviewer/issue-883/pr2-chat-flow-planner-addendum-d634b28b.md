# Chat messages keep their rows and new messages remain visible

**Reviewed at 39c24f37:** multiline fitting and current-tail following are
accepted. The existing restoration rule still fails after scrolling an older
chat, and the held-growth observation needs its permanent witness. Execute
[the narrow correction](pr2-terminal-completion-implementor-correction-39c24f37.md).
The contract below remains authoritative; its old starting base is historical.

Apply this addendum with
[the current terminal correction](pr2-terminal-completion-implementor-correction-d634b28b.md)
from signed clean d634b28b24afa9a16a0a10ec7906c09d924c9db9, parent ab681d4a.
The Product Owner reports that chat messages overwrite earlier messages and
requires new messages to be added at the bottom while the list moves upward.

This adds two demonstrated problems to the assignment: chat text is not fitted
into visual rows before layout, and the current chat does not follow its newest
messages. Header edges and the requested sidekick spelling correction remain
assigned. TE1–TE3's data/routing evidence and earlier identity/ownership/
disclosure contracts stay accepted.

## Evidence at the exact base

The [real mounted probe](pr2-chat-flow-probe-d634b28b.test.ts) and
[first output](pr2-chat-flow-probe-d634b28b-first.log) preserve two failures and
one passing control:

- A reply containing first-A, first-B and first-C on separate lines loses
  first-B/first-C when the next exchange is drawn. Both replies remain saved.
- Twelve replies are acknowledged on disk, but the pane still displays
  ANSWER-1 through ANSWER-10; ANSWER-12 never reaches the screen.
- Two short replies that fit are retained on screen in order.

This is not loss from the journal. sidekickChatRows retains separate message/
response identities. The display makes one Described row per message, while
rowProps fixes that row's height to one. Raw multiline or wrapping text can
therefore draw over the next logical row. The chat has no prepared fitted-row
list comparable to the entry reading and question preview.

offsetFor returns the stored Sidekick offset unless Sessions requested a turn
reveal. Appending rows never moves that offset to the newest end of the list.
Scrolling a fixed prefix cannot display newly appended messages automatically.

## Required behavior

Each person message, reply, live Preview, saved attempt and inert saved-turn
item keeps its own place in chronological chat order. Fit complete literal
content to the pane's actual measured width before counting or selecting rows.
Preserve line breaks, blank lines, whitespace and graphemes. A message that
wraps occupies as many visual rows as it needs; the following message begins
after them. Do not truncate chat text or remove earlier items to make room.

The response identity is unchanged: streaming updates and its evaluated reply
or Incomplete state occupy the same item. Fitted continuation rows are private
display rows under that item, not new messages, turns, responses or records.
Existing exact parent keys and cross-chat ownership remain intact.

**Default scrolling rule for this assignment:** the current chat initially
follows its newest messages. When a new message arrives, or its live Preview
grows while the view is at the bottom, the measured window moves far enough
to keep the latest visible rows at its bottom. Earlier rows move up and remain
reachable with the existing scrolling controls.

When the person explicitly scrolls upward, preserve that reading while
background messages arrive. Reaching the bottom with the existing later
control resumes following. This is the recommended behavior presented in the
optional preference question; the Product Owner's later answer overrides this
default if different. No extra unread badge or new scrolling control is assigned.

Explicit Sessions turn reveal takes precedence over following. A previous
chat stays selected and read-only while the current one works; background
arrivals do not retarget it. Returning to the current chat restores its current
following/manual reading state. A tab change, resize or temporarily hidden pane
does not move focus, open a drawer, discard either composer or resume work.

A resize computes fitting and the window against its new measured capacity.
At 60x15 the existing refusal remains; recovery preserves the chat, drafts,
question state and following/manual reading choice. No scroll position is
added to the URL or saved history.

## Implementation boundaries

Reuse the existing frame preparation, fitPlain/engine measurement, window
clamping and owner.changes notification. Allow changes to program.ts and
application.ts's private prepared-frame/chat rows and local viewport state,
plus fitting.ts only where necessary to reuse the existing fitting operations.
The rendering, row count, scrolling and Sessions reveal must consume the same
prepared visual rows for the same selected chat and measured width.

Private prepared values and ordinary local helpers have concrete consumers
here; no generic scrolling framework, second terminal host, renderer replacement,
public Core/provider API, durable mapping or new record is authorized.
Keep the disclosure gate: fitting uses already cleared literal text and cannot
publish unvalidated generated source or bypass withdrawal.

Do not repair overwrite by widening the pane, weakening renderer validation,
turning off its checks or escaping away meaningful line breaks. Follow the
existing cancellation/ownership rules; frame preparation owns no agent work.

Align specs/repl-spec.md and architecture.md with the implemented complete
chat fitting and following behavior. Keep the pane/header refinement and the
seven-row footer. The user request broadens the previous correction's source
scope to these specific chat/frame paths; it does not reopen accepted Core,
admission, journal or configuration designs.

## Frozen added evidence: CF1–CF3

Use the existing mounted fixture and permanent Sidekick journey/presentation
destinations. No new mutation battery is assigned.

| Row | Required observations |
| --- | --- |
| CF1 — complete messages | Two real exchanges, including explicit newlines, a blank line and a line wide enough to wrap, preserve every part of the first message when the second arrives. Check order and disjoint visual rows against measured width, with headers/composer/footer intact. Actual saved texts remain complete. Pair with the existing short-message control. |
| CF2 — current chat follows new messages | Overflow the chat with actual acknowledged exchanges; show the last reply at 160x36, then 120x30 and explicit narrow Sidekick at 72x20. Earlier messages stay saved and reachable by scrolling. Grow a held live Preview across another row boundary with terminal.fed unchanged and show its latest rows. Settlement keeps the same item and the latest reply visible; preserve both drafts. Existing refusal/recovery rows preserve their claims under the new fitting. |
| CF3 — deliberate reading stays put | Scroll upward while the next real response is held, release it and show that the older visible reading does not jump while the new reply is saved. Scroll to the bottom and show following resumes for the next arrival. Reuse accepted SS read-only/turn-reveal rows to prove a background arrival neither retargets an older chat nor defeats an explicit turn reveal. |

Current-size committed frames and real transport/record barriers establish
readiness. Failure deadlines do not substitute for it. Assert actual text and
its positions, not only unique keys or complete files.

Where correct following moves an earlier accepted message offscreen, retain
its content assertion by scrolling back to it or reading its actual retained
record. Report that adaptation; do not erase the assertion or mistake absence
from the current window for deletion from the chat. Keep all source/output/
receipt and ownership assertions.

## Commands and return

Run the current correction's original six commands, added boundaries selection
and header-edge probe, then this unchanged chat probe:

```sh
deno task test /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-chat-flow-probe-d634b28b.test.ts
```

The earlier seed diagnostic remains a rejected hypothesis, not a required-green
test. Preserve all first outputs. No full suite, broad check/lint/JSR, CI,
dependency repair, push, GitHub mutation or capture is added.

Return one signed correction commit with the header/spelling work, CF1–CF3
mapping, exact commands/results, first outputs and every assertion/fixture
adaptation. Continue autonomously until the finite evidence passes, or return
a concrete scope/contract conflict before expanding it.

Base: d634b28b, parent ab681d4a. Artifact:
.reviewer/issue-883/pr2-chat-flow-planner-addendum-d634b28b.md.
Next Implementor action: execute this addendum together with the linked current
correction. The unfamiliar-agent teaching walkthrough, 36-frame packet and
delivery remain separate.
