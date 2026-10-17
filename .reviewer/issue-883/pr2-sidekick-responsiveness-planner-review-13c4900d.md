# Responsiveness review: REQUEST CHANGES at 13c4900d

The measured performance fix and all three earlier correctness items are
accepted. Unchanged chat lines are reused, hidden chat is not fitted, each chat
keeps its own reading, held Preview growth is now permanent, and header prose
is corrected. Finish the remaining frozen RS4/RS5 observations, remove one new
fixture cast and describe the retained chat cuts in architecture.md.

Execute [the tests-and-prose correction](pr2-sidekick-responsiveness-implementor-correction-13c4900d.md).
No production redesign or new test matrix is assigned. The composer remains
unreleased while its height cap awaits the Product Owner.

## Exact revision and governing contract

- SHA: `13c4900dbf0c4e57411241ada84aa00f4b55ba65`.
- Parent: `39c24f37fdb967c3aa90870f9b4e22e536dc0fec`, preserved.
- Branch agent/issue-883-pr2; signature G / tarasm@gmail.com.
- Implementation worktree independently clean, nothing untracked.
- Seven files, +715 / −50: three production modules, two test files and two documents.

[The continuation prompt](pr2-sidekick-responsiveness-implementor-prompt.md)
freezes RS3–RS5 and the inherited CF-P1/CF-E1/prose correction. The
[handback](pr2-sidekick-responsiveness-implementor-handback.md) reports the exact
commit and all twelve focused runs. Sessions, Preview, Configure, recovery,
admission and Core/ACP remain accepted.

## Accepted implementation

createPlainFitStore retains geometry for exact text, room and terminal size.
Current keys and token runs are decorated afresh. Completed per-line cuts can
be reused while a tail grows; a successful preparation retains only that line
set. Dimensions changing discard the previous set. The running command owns
separate entry and chat stores, and chat storage is threaded through every real
paint/commit and geometry path. This is the intended local lifetime and does
not add global state, a durable record or an agent operation.

prepareFrame checks the measured manifest for SIDEKICK_WINDOW before fitting
chat text. It uses the existing presentation's visibility answer. The actual
engine and existing grapheme-safe fitting remain in place, and one fitted list
still supplies drawing, admission, scrolling and turn reveal.

The current/older-chat scrolling correction is accepted. Offsets and following
are keyed by the reading's own chat. Both unchanged behavioral arms pass, and
the permanent two-chat journeys observe following and deliberate current
reading surviving a visit. Keeping the private sidekick field name for the
unchanged diagnostic is a harmless adaptation; no behavior depends on the name.

CF-E1 now holds thirty streamed rows, grows TAIL-LAST without input, observes
no saved response at that boundary, and settles with the latest line and both
composers intact. The two header sentences and rowBox comment now account for
the border's actual row while keeping the footer at seven rows.

RS3 is sufficient. Independent counts match the handback: three short messages
warm in 11 renders; twelve wrapping messages warm in 728; both Draft and Message
typing then cost four. Existing RS2 remains intact. The mounted diagnostic also
shows one presentation per key and no idle presentations.

## RS-E1 — complete the already-frozen RS4/RS5 observations

These are omissions from the assigned rows, not new permutations.

RS4 currently begins with three settled items and adds `grown` as a fourth item,
then adds `appended` as a fifth. It proves reuse while appending, but does not
change the text of an existing final Preview item under its stable key. Its
warm/cold comparison reads only mounted keys. Matching keys cannot establish
the assigned visible text and fitted row count.

Keep the same row and cost comparison. Start with an existing final Preview,
grow its text under that key, then append the next item. Compare the resulting
prepared chat rows with uncached fitting, including text, keys and row count,
and retain a visible current-text observation. Keep the Unicode/blank-line
fixture. No new host or mutation battery is needed.

RS5 logs hiddenLongWarm but never asserts it against a cold empty-chat frame;
only the warmed typing counts are compared. Assert the initial hidden-frame
claim as well, comparing equivalent cold frames so entry-store warmup is not
mistaken for chat fitting.

RS5's “another chat” passes `chat-one` again and its chat rows remain owned by
chat-one. Its “replaced final line” adds a second reply rather than withdrawing
or replacing the existing Preview. Complete the existing bounded sequence with
a genuinely different chat identity and an existing Preview that is withdrawn
or replaced. Compare full prepared rows/text/counts with uncached preparation
at those transitions; the current mounted-key equality cannot prove content or
disclosure withdrawal. Preserve the resize and hidden/showing observations.

## RS-P1 — remove the newly added fixture cast

repl-presentation-style.test.ts:2825 returns
`Object.freeze(...) as ReplSidekickReading`. AGENTS.md rule 6 forbids type casts.
chatOf already declares a ReplSidekickReading return type; construct a typed
fixture without asserting an incompatible value into that type. No production
parser is needed for a test's own literal. Do not introduce another cast.

## RS-D1 — document retained chat geometry

The prompt explicitly assigns architecture alignment for command-owned retained
chat geometry. The document diff corrects only the header sentences. Add a
short paragraph beside the existing chat fitting description: independent
command-owned cuts, exact-input reuse, successful-set pruning, dimension
invalidation and hidden-chat avoidance. State implemented behavior without
benchmark numbers or new terminology. No public specification expansion is
required for a private cache.

## Independent verification

Commands are the continuation's eleven exact selections. First outputs are
retained as pr2-responsiveness-review-13c4900d-command-N-first.log.

| # | Selection | Result, tests / steps |
| --- | --- | --- |
| 1 | storage/recovery | 12 / 63, green |
| 2 | controls/output/entries/route/history | 46 / 194, green |
| 3 | Sidekick journeys/lifecycle, agent journey, forms/lifecycle/source | 36 / 187, green |
| 4 | configuration/presentation/help/layout/real PTY/style | 47 / 176 passed; one test / two PTY steps failed |
| 5 | ordinary journey/agent interface/execution | 58 / 142, green |
| 6 | five unchanged Preview/Sessions probes | 5 / 10, green |
| 7 | boundaries | 4 / 26, green |
| 8 | unchanged header-edge probe | 1 / 2, green |
| 9 | unchanged chat-flow probe | 1 / 3, green |
| 10 | unchanged chat-reading probe | 1 / 2, green |
| 11 | unchanged held-growth probe | 1 / 1, green |

Command 4's real-PTY rows fail because their private tmux sockets cannot be
read, the already-recorded review environment limitation. All other rows,
including M1, RS3–RS5 and CF-P1/CF-E1, pass on first invocation. L2/U2 did not
recur. No unchanged rerun was needed or used to discard a failure. The
Implementor's all-eleven positive evidence remains separately recorded.

The [unchanged mounted diagnostic](pr2-responsiveness-review-13c4900d-mounted-diagnostic-first.log)
passes 1 / 1 after the other selections finish. Median times observed here:
empty 9.55 ms, twenty wrapped lines 20.35 ms, one hundred visible lines 21.72 ms,
the same hidden lines 8.94 ms. The handback's 9.69 ms populated result is a
separate local run. Both are diagnostic improvements over the earlier 151.97 ms;
the deterministic counts, not machine timings, establish reuse.

No tracked source/test was changed during review. No cache/dependency repair,
broad suite, CI, capture, push or GitHub mutation occurred.

## Continuity

Reviewed head: signed clean 13c4900d; its production responsiveness and scrolling
corrections are accepted. Full terminal feedback acceptance awaits the narrow
tests/prose correction. Latest fully accepted earlier head remains ab681d4a.
Preserve all ancestors. The composer draft now records 13c4900d rather than
stale in-flight work at 39c24f37; it remains unreleased pending the cap answer
and review completion. Teaching, captures and delivery remain separate.
