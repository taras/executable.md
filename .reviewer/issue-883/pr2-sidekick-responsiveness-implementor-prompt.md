# Keep typing responsive as the Sidekick chat grows

**Completed: PASS at signed clean 25227d38.**
[The closing review](pr2-sidekick-responsiveness-planner-review-25227d38.md)
accepts this continuation and its evidence correction. Nothing remains assigned
under this prompt; hold for the composer release after its height answer.
Earlier current-action notes and implementation bases below are historical.

**Reviewed at signed clean 13c4900d:** the production responsiveness fix and
inherited chat correction are accepted. Finish
[the narrow tests/prose correction](pr2-sidekick-responsiveness-implementor-correction-13c4900d.md)
from that committed head. The earlier 39c24f37 implementation assignment below
is complete; its RS4/RS5 requirements remain authoritative. Only the new
correction's focused two-file command is required for its feedback.

**Additional Product Owner request:** Message Sidekick also needs wrapping and
vertical growth. [The prepared composer addendum](pr2-sidekick-message-composer-planner-addendum.md)
records the source finding and settled requirements. Its height cap awaits the
Product Owner's answer; it is not yet released for implementation. Continue the
existing assignment below without choosing that cap or discarding in-flight work.

Follow .agents/implementor.md. Execute this bounded continuation in
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`.
It adds the Product Owner's requested responsiveness fix to the open terminal
correction. One Implementor owns both because they touch the same frame and
chat paths. Return one signed feedback commit.

## Start here

- Branch: agent/issue-883-pr2.
- Base: `39c24f37fdb967c3aa90870f9b4e22e536dc0fec`.
- Parent: `d634b28b24afa9a16a0a10ec7906c09d924c9db9`.
- Signature G, tarasm@gmail.com; independently verified clean, no untracked files.
- Verify the actual head and tree before editing. Preserve ancestors; no amend,
  reset, rebase or unrelated main changes. If the branch has advanced, account
  for that work before using this base; do not reset it.

Read these main-checkout artifacts in full:

1. [Measured latency diagnosis](pr2-latency-39c24f37-report.md).
2. [Current correctness correction](pr2-terminal-completion-implementor-correction-39c24f37.md)
   and [its exact review](pr2-terminal-completion-planner-review-39c24f37.md).
3. [Chat-flow contract](pr2-chat-flow-planner-addendum-d634b28b.md).
4. [Terminal plan and its six exact commands](pr2-terminal-completion-planner-handoff.md).

This prompt supersedes the earlier correction's exclusion of a latency remedy.
Its three correctness items remain assigned: independent current-chat scrolling
after an older-chat visit, permanent held Preview growth evidence, and two header
prose alignments. Header edges, spelling, multiline rendering, TE5/J1 adaptations
and all earlier Core/ACP, owner, admission, recovery, Configure and Sessions
contracts remain accepted.

## Fix the measured work

An ordinary key currently refits every chat line through fitPlain in
program.ts's prepareFrame, even when Bindings hides the chat. Twenty wrapping
messages require 1,284 measurement renders on every frame. A mounted command
with 100 wrapping lines took about 152 ms/key locally, compared with 16 ms
empty. Each key drew one frame and idle drew none. Fix the repeated text fitting;
the evidence does not call for changing notifications, batching or timers.

1. Retain plain-text line cuts in storage owned by the running command's frame
   preparation. Create it once alongside the existing entry fit store and pass
   it through the real paint/prepare path. Keep entry geometry and chat cuts in
   independent storage so one cannot evict the other. Ordinary private helper
   names and parameter plumbing are delegated; no Core or provider API changes.
2. Reuse a line's cuts only for its exact text, measured content width, terminal
   size and other inputs the existing fitter actually uses. Keep current keys,
   text and token runs on the current frame; retain geometry rather than stale
   decorated rows. Unchanged earlier lines must remain reusable when the newest
   Preview line grows or another message is appended. A whole-list-only cache
   is insufficient for that case.
3. Bound retention to the latest prepared selected-chat line set and one set of
   measured dimensions. After successful preparation, replace that set and
   remove replaced/deleted lines and obsolete Preview versions. A hidden pane
   may retain the last set without extending it. No process-global or durable
   cache, timer, hash-only equality or cache of every historical size/chat.
   A failed or cancelled preparation must not publish incomplete geometry as a
   completed answer; retaining individually completed, exact-input cuts is safe.
4. Skip chat fitting when the measured frame presents no chat viewport. Derive
   this from the existing presentation/manifest rather than inventing another
   pane-selection rule. Reopening or revealing the chat must fit current text
   against current geometry before admitting or drawing its rows.
5. Keep the actual engine's Unicode width answers, grapheme-safe cuts, literal
   whitespace/newlines and refusal behavior. The same prepared fitted list must
   still feed descriptions, row counts, scrolling and Sessions turn reveal.
   Disclosure withdrawal must remove old preview text immediately; cached cuts
   never authorize showing text absent from the current cleared display facts.

Production scope: fitting.ts, program.ts and application.ts only where the
existing chat composition/viewport correction requires it. Use existing tests
and fixtures. Do not replace the renderer, weaken validation, approximate widths
with string length, alter the journal, change agent work, or build a generic
performance framework. Align relevant architecture prose with retained chat
geometry and its command lifetime; no new vocabulary registry term is needed.

## Frozen responsiveness evidence

Add a small tier to repl-presentation-style.test.ts beside its existing RS2
frame-cost test. Use useCountingRenderer, the real tree and commitReplFrame,
with the same retained stores the production command owns. These are display
fixtures for deterministic frame work, not claims about agent learning.

| Row | Required observations |
| --- | --- |
| RS3 — typing reuses unchanged chat | Warm a short chat and a long wrapping chat, then change only Draft and only Message in separate frames. Warmup genuinely costs more for the long chat. Subsequent measurement counts do not grow with that unchanged chat history and equal the structural baseline for the same layout. Draws and edited texts remain correct. Preserve existing RS2 entry-cache assertions. |
| RS4 — growing text measures only its change | Warm a chat with several wrapping lines; grow one final Preview line, then append one message. Compare each update's additional text-fitting work with fitting those changed/new lines alone at the same measured dimensions. Earlier lines are reused; current visible text, exact parent/continuation keys and fitted row count match uncached fitting. Include blank lines and a wide/combining grapheme in this same fixture. |
| RS5 — visibility and invalidation | With Bindings hiding the chat, both initial preparation and subsequent typing add no chat-text measurement work. Show the chat and observe its current text. Then resize, switch to different chat text and withdraw/replace the Preview in one bounded sequence; compare output and row counts with uncached preparation at each transition. No stale text, keys or geometry remains. |

Use measurement counts as assertions, not an absolute millisecond budget.
Keep the existing counting-renderer instrumentation; a narrowly additive helper
is allowed if it is needed to distinguish structural passes from text fitting.
Do not mock the fitter or engine. No extra size/agent permutation or mutation
battery is assigned.

Promote the held real-stream growth row already assigned by CF-E1, and preserve
the mounted same-item, no-input, composer and disclosure assertions. This is the
real command witness beside RS3–RS5's deterministic frame-work witnesses.

## Focused commands

Run the prior correction's eleven commands against the final tree: the terminal
plan's six exact commands, repl-boundaries, the unchanged header-edge probe,
the unchanged chat-flow probe, the unchanged chat-reading probe, and the
unchanged chat-live-growth probe. RS3–RS5 run within the existing command 4's
repl-presentation-style.test.ts selection. No additional complete suite is added.

Also rerun the unchanged real mounted latency diagnostic:

```sh
deno task test /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-latency-39c24f37-mounted-probe.test.ts
```

Report its empty/populated/hidden input-to-presentation times and frame counts
as local diagnostics. Its passing exit alone does not establish the performance
fix; RS3–RS5's discriminating count assertions do. Keep the original baseline
report and diagnostic probes unchanged. No required run or rewrite of the old
frame diagnostic is added: its original store plumbing predates chat retention.

Preserve first failures. The Planner's private tmux-socket limitation and open
M1 focus flake are not assigned repairs. Do not weaken assertions or alter
dependencies, shared caches, locks or discovery to obtain a pass. No broad
lint/check/JSR, runtime battery, push, GitHub write, CI inspection or capture is
authorized by this prompt. Leave REPL_DESCRIPTION and SIDEKICK_QUIET outside it.

## Complete the assignment

Continue through the finite implementation and evidence without stopping at
progress checkpoints. Give brief progress updates while working; stop early
only for a concrete contract conflict or missing required authorization.

Once the focused evidence passes, commit promptly with repository signing.
Hand back the exact SHA/parent, branch/signature/clean state, every command and
result, before/after measurement counts and mounted diagnostic times, first
outputs, and every fixture/assertion adaptation. Explain cache ownership,
invalidation and retention bound. Stop for review of that exact commit.

Base: 39c24f37. Produced: this continuation prompt, using the linked diagnosis
and existing correctness correction as its plan. Settled: exact-input reuse,
command ownership, hidden-chat avoidance and unchanged rendering/agent behavior.
No product or architecture question is pending. Next Implementor action: execute
this combined continuation. Teaching, the 36-frame packet and delivery remain
separate.
