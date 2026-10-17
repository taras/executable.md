# Terminal correction review: REQUEST CHANGES at 39c24f37

The header edges, corrected sidekick spelling, multiline chat rendering and
current-chat tail following are accepted. One frozen scrolling rule still
fails: scrolling an older chat changes where the current chat returns. The
held live-growth requirement works in an independent mounted probe, but needs
its assigned permanent witness. Two header descriptions also need alignment.

Continue through [the narrow correction](pr2-terminal-completion-implementor-correction-39c24f37.md).
The Product Owner's separate latency investigation is complete in
[the diagnostic report](pr2-latency-39c24f37-report.md); it changes no production
source and is not silently added to this correctness assignment.

## Exact revision

- SHA: `39c24f37fdb967c3aa90870f9b4e22e536dc0fec`.
- Parent: `d634b28b24afa9a16a0a10ec7906c09d924c9db9`, preserved.
- Branch agent/issue-883-pr2; signature G, tarasm@gmail.com.
- Worktree: `.claude/worktrees/issue-883-pr2`, independently clean with no untracked files.
- Eighteen files; production, tests/fixtures and two documents.

The [terminal plan](pr2-terminal-completion-planner-handoff.md),
[previous correction](pr2-terminal-completion-implementor-correction-d634b28b.md)
and [chat-flow addendum](pr2-chat-flow-planner-addendum-d634b28b.md) govern this
review. Prior Sessions, Preview, Configure, admission, recovery and Core/ACP
acceptances remain closed.

## Accepted corrections

The two header bands now have real engine-accounted bottom borders. Measurement
and committed frames use the same decoration, the footer remains seven rows,
and the unchanged header probe finds 91 Transcript and 35 inspection edge cells.
TE4 directly checks the actual edges and body fills under both tabs.

The active tracked implementation contains no case-insensitive sidekit match.
The real CLI uses --sidekick-agent, with no alias, and the boundary/help/profile
tests preserve valued-option refusal and independent agent selection.

Chat text is split on its own line breaks before width fitting. The prepared
visual rows feed drawing, admission, scrolling and turn reveal. Earlier text
keeps separate rows, blank lines and wrapped content; the unchanged three-arm
chat probe passes. Current tail following, same-chat deliberate scrolling and
resize behavior are observed in the new permanent rows.

TE5 now cites CV32/PV5 as prior reviewed fatal-classification evidence and
attributes CLI/configuration evidence to command 4. No new Core command is
claimed. The singular REPL_DESCRIPTION and unused SIDEKICK_QUIET remain outside
this correction as previously directed.

J1's adaptation is accepted. Its copied location opens the binding drawer and
defaults the right pane to Sidekick, so the old Bindings-column text came from
a stale reconstructed cell. The new assertions read the named binding and its
value from the drawer actually opened; Escape waits for that drawer to close.
Reconstruction, retained entry and no-provider assertions remain intact.
SS6's exact rejoined three-row status also preserves its original claim.

## CF-P1 — visiting an older chat changes current scrolling

The addendum requires: “Returning to the current chat restores its current
following/manual reading state.” ReplViewports currently has one Sidekick
offset and one following flag. scroll-sidekick changes both for any selected
chat; read-current-chat clears the selector without restoring the current
chat's reading.

The [paired behavioral probe](pr2-chat-reading-probe-39c24f37.test.ts) starts
with the current chat at its tail, visits an older chat, then goes Back:

| Arm | Current window before | Current window after Back | Latest current reply |
| --- | --- | --- | --- |
| Scroll the older chat | from 5, more false | from 2, more true | absent |
| Visit without scrolling | from 5, more false | from 5, more false | present |

The [behavioral output](pr2-chat-reading-probe-39c24f37-behavior.log) preserves
the failing regression and passing control. This proves an existing criterion
unmet; it adds no new durable state or product behavior. The probe asserts
window/output behavior rather than requiring the current private viewport shape.
Its first compile output is retained separately: a reviewer closure lost a
union narrowing; correcting that fixture did not change production.

Keep the current chat's following/manual reading independent of older-chat
scrolling. Use process-local viewport state, existing chat identity and measured
windows. Preserve explicit turn reveal priority and read-only ownership.

## CF-E1 — retain the held live-growth witness

CF2 explicitly asks for a held Preview growing across another visual row with
terminal.fed unchanged, then settlement in the same item with drafts preserved.
The new CF2 row drives twelve settled replies and resizes; the existing short
Preview changes do not cross a visual row boundary.

The [positive mounted probe](pr2-chat-live-growth-probe-39c24f37.test.ts) proves
the requested behavior already works: thirty held lines overflow the window,
TAIL-LAST arrives without input while the provider remains held, no response
has been saved yet, and settlement saves response:1 with that final line still
visible and both composers intact. Its [first output](pr2-chat-live-growth-probe-39c24f37-first.log)
is green. Promote that finite witness into the permanent CF2 destination.
Reuse the accepted same-item identity evidence; no product redesign or added
mutation battery is required.

## Documentation alignment

architecture.md still says header chrome takes no row from the reading;
specs/repl-spec.md still says a header costs the rows beneath it nothing.
headerBandProps now reserves rows + 1 for its bottom border. Align those two
sentences with the actual accounted edge and unchanged seven-row footer.
The implemented border is accepted; this is a prose correction.

## Independent focused evidence

The exact commands are the original six in the linked plan, followed by the
boundary selection, unchanged header probe and unchanged chat-flow probe in
the previous correction. Counts below are tests / steps. Every first output is
retained under pr2-terminal-review-39c24f37-command-N-first.log.

| Command | Selection | Result |
| --- | --- | --- |
| 1 | Sidekick storage/recovery | 12 / 63, green |
| 2 | controls/output/entries/route/history | 46 / 194, green |
| 3 | Sidekick journeys/lifecycle, agent journey, forms/lifecycle/source | 36 / 187, green |
| 4 | configuration/presentation/help/layout/real PTY/style | first: 45 / 169 passed; M1 and real PTY failed |
| 5 | ordinary journey/agent interface/execution | 58 / 142, green |
| 6 | five unchanged Preview/Sessions probes | 5 / 10, green |
| 7 | repl-boundaries | 4 / 26, green |
| 8 | unchanged header-edge probe | 1 / 2, green |
| 9 | unchanged chat-flow probe | 1 / 3, green |

Command 4 was rerun unchanged after preserving the first output. It finished
46 / 170 passed with only the two real-PTY steps failing because their private
tmux sockets were unavailable. M1 also passed its unchanged isolated tier.
This is not an independent all-nine-green claim. The Implementor's all-nine
positive evidence at this exact commit remains separately recorded.

The initial M1 focus assertion is intermittent; its cause is not established.
The [open local flake record](pr2-mounted-initial-focus-m1-flake-39c24f37.md)
preserves both outputs. No assertion, dependency or cache was changed to obtain
the rerun, and no flake repair is added here. L2/U2 did not recur. No broad
suite, CI, capture, push or GitHub mutation was run.

## Separate responsiveness diagnosis

At the Product Owner's request, a read-only agent measured a concrete cause:
every typing frame refits all chat text, even hidden behind Bindings. A mounted
empty chat took about 16 ms/key locally; two actual replies totaling 100 wrapped
lines took about 152 ms/key, visible or hidden. Each key drew one frame and idle
drew none. Twenty wrapping messages required 1,284 measurement renders per frame.

The linked diagnostic includes both passing probes, first outputs and a bounded
candidate: retain unchanged plain-text cuts in frame-owned storage and skip
hidden chat fitting. These are local diagnostic times, not portable thresholds.
No performance implementation or notification redesign is authorized by this
review's correctness correction. A responsiveness assignment can use that
evidence without rediscovering the cause.

## Continuity

Reviewed head: signed clean 39c24f37; latest fully accepted head remains ab681d4a.
Header/spelling/overwrite/tail fixes and TE5/J1 adaptations are closed. The
linked correction contains only CF-P1, permanent CF-E1 and two prose alignments.
No architecture interview is pending. Teaching, the 36-frame packet and
delivery remain separate. Preserve this commit and all ancestors.
