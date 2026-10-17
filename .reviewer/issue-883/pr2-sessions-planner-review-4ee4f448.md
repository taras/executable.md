# Sessions review: REQUEST CHANGES at 4ee4f448

The bounded Sessions slice is not accepted. All seven focused selections and
both unchanged Preview probes pass independently, but three additional checks
reproduce violations of the frozen layout, identity and selected-turn contracts.
Several required observations in SS1–SS7 are also absent from the new rows.
Execute [the correction prompt](pr2-sessions-implementor-correction-4ee4f448.md)
from this exact signed head, preserving it and its parent.

## Exact revision and scope

- SHA: `4ee4f44824ce39f41385e70cce107bd0d110ec6c`.
- Parent: `10b17a40fb07eb2fe623c9b4e4a5259d0501fe9a`, preserved.
- Branch: agent/issue-883-pr2; signature G, tarasm@gmail.com.
- Implementation worktree: `.claude/worktrees/issue-883-pr2`.
- Independently verified clean, no untracked files.
- Seventeen files, +3377/−135: seven production files, seven tests, one fixture
  and two documents. The handback's six-production-file count is off by one.

Governing sources are [the frozen plan](pr2-section5-sessions-planner-handoff.md)
and [the completed Architect decision](pr2-section5-sessions-architect-decision.md).
Two owner sections, independent actual-key filtering, the sidekick= selector,
read-only earlier chats and the existing one-publisher composition remain the
accepted design. The public widening is the approved location member only.
The direct-provider, configuration, recovery, question and Preview acceptances
are not reopened. Latest accepted head remains `10b17a40`.

## SS-P1: ordinary population can end the command

At the exact commit, send ordinary short messages through runReplProgram with
the existing mounted fixture. Each successful response is acknowledged before
the next Send. On the sixth message the real renderer raises:

```text
ReplRenderError: the engine placed node-8 at a fractional position
(x=0, y=24.0078125, width=32, height=1)
```

This is the supported 160x36 frame, not a terminal below the minimum. The
[populated probe](pr2-sessions-populated-probe-4ee4f448.test.ts) uses only the
real Message/Send path, profile, repository, owner and controlled transport.
[Its first output](pr2-sessions-populated-probe-4ee4f448-first.log) records
messages 1–6 before the renderer failure. The one-message control passes in
the same invocation. No provider failure, invalid response or injected finished
state causes it.

SS7 explicitly requires populated windowed navigation and valid frames. The
new three-profile row uses one conversation with one turn, selects that same
active chat, and does not reach an off-window turn. It cannot expose this
population failure. Correct the application measurement/layout connection so
the growing readings remain valid cell layouts. Do not round renderer geometry,
relax its validator, discard saved turns, shrink the corpus or patch vendored
code as a workaround.

## SS-P2: a current failure can rename an older chat's attempt

program.ts's sidekickChatRows() now composes every chat. Its `addressed` value
still contains only turn and response; the incomplete-item branch tests only
the turn number. A failed turn in the current chat therefore applies its local
response alias to an older chat's failed turn with the same number.

The older chat may have an unacknowledged first message, then its successful
`response:2` at saved turn 1 and failed saved turn 2. A current chat's failure
at turn 2, registered as `response:2`, then produces these old-chat rows:

```text
chat:old:response:2  reply
chat:old:response:2  incomplete
```

The [cross-chat probe](pr2-sessions-cross-chat-probe-4ee4f448.test.ts) projects
canonical-record fixtures through the production reader, then composes the
current local preview with sidekickChatRows(). The fixtures preserve the
accepted request boundaries and message/turn divergence. The regression gets
four unique keys for five old-chat items; its no-divergence control passes.
[First output](pr2-sessions-cross-chat-probe-4ee4f448-first.log) records both.
The fixture was then made explicit about two different agents, matching an
ordinary agent replacement; both assertions are unchanged and
[that output](pr2-sessions-cross-chat-probe-4ee4f448-distinct-agents.log) has the
same regression failure and passing control.
This is a pure composition proof, not a claim to have run a provider against
those fixtures. The direct source trace shows the duplicate descriptions enter
the selected old chat's row builder, where the existing reconciler rejects
duplicate sibling keys.

The alias must belong to its exact chat and saved turn. A current observation
must leave old-chat identities alone. Do not deduplicate either item, infer a
response from a turn, rewrite history or weaken the reconciler. This is SS4/SS6
and the explicit owner-domain rule, not a new identity design. The two previous
Preview probes remain green because their relevant composition has one chat.

## SS-P3: navigation uses the viewport of the reading being left

application.ts's read-sidekick-turn reduction calls revealing() with the old
frame's admission. revealing() returns the old offset when that admission has
no SIDEKICK_WINDOW. A narrow Sessions frame correctly has no chat viewport;
opening a chat from it therefore retains offset zero instead of revealing the
selected later turn. A Bindings frame has the same absence boundary.

The [reveal probe](pr2-sessions-reveal-probe-4ee4f448.test.ts) uses canonical
fixtures, the production row compositions, actual prepareFrame admission through
usePresenter(), semantic reduction, and a real committed destination tree/grid.
At 72x20 it selects turn 5, but the destination mounts only turns 1–2:

```text
hadChatWindow: false
offset: 0
targetMounted: false
```

The wide control has the chat viewport and mounts the target. The paired
[runtime output](pr2-sessions-reveal-probe-4ee4f448-runtime.log) is preserved.
This is a measured composition/reducer proof; its permanent counterpart must
also exercise the mounted control required by SS4/SS7.

Preserve the exact turn to reveal until the destination window is measured.
Reveal that turn's evaluated reply or inert turn anchor, rather than merely
the first person item with the same turn number. Keep this process-local and
root-owned; no route scroll field, guessed geometry or second focus store.

## SS-E1: complete the observations already frozen

These are omissions from the assigned matrix, not added acceptance permutations:

1. **SS1 and SS7:** the two section rows count titles before/after but do not
   compare actual mounted identity across publication. No held evaluation
   captures the saved Prompt separately from its still-running response. The
   no-input row jumps from a transport hold to the final completed response;
   it does not observe cleared text, saved Prompt and held evaluation as the
   separate material facts the plan requires. Complete those real boundaries.
2. **SS2:** the cold unknown-ID row waits for its entry to settle before saving
   the files. It proves pure cold refusal over a settled entry, not refusal
   before an unfinished entry could resume. The route helper merely supplies
   chat IDs and cannot establish a prepared/failed chat's actual setup status.
   Add the assigned real cold setup/unfinished arms. The current detached chat
   reading and its row builder expose no setup phase/failure, so merely
   resolving the ID and saying No messages yet does not satisfy that arm.
3. **SS3:** the live-key row releases the canonical append before clicking Stop
   and never asserts the absence of a saved turn or cold refusal of an
   exclusively ephemeral key. Do not substitute that for Stop before
   acknowledgement. The equal-key recovery row has one actual turn and a
   second empty chat; it asserts neither an entry/Sidekick shared-key filter
   nor two owner rows. Complete the assigned evidence interpretation case.
4. **SS4/SS7:** the older-chat test explicitly has zero entries, so its comment
   about preserving a selected entry is not witnessed. It holds no current
   partial question. The profile row visits an explicitly selected active chat,
   not a nonactive read-only one, and tests neither mounted/target absence nor
   off-window turn activation. Add the specified selected-entry, partial-form
   preservation and populated three-profile observations; use them to close
   SS-P1/SS-P3 rather than adding a second layout matrix.
5. **SS6:** the new real-owner failure row has ordinary sequential turns, not
   the assigned interrupted-first-message gap. The original Preview probe
   proves chat composition, not the new Sessions row identity. Extend the real
   gap/feedback boundary evidence to the new Sessions facts and selected inert
   anchor. Existing recovery files can supply the real retained interruption;
   there is no need for another journal or recovery framework.

Keep the existing cold copied-location, actual-key prefix and basic read-only
positive evidence. Finish only these required gaps, preserving the existing
assertions. Do not broaden the matrix to unrelated policies, permutations,
diagnostic hardening or delivery checks.

## Independent focused evidence

All first outputs were preserved before any diagnostic rerun or refinement.
Every frozen selection passes on its first independent invocation:

| Selection | Result | First output |
| --- | --- | --- |
| Mounted Sidekick / owner journey / lifecycle | 28 tests / 98 steps | [mounted](pr2-sessions-review-4ee4f448-mounted-first.log) |
| Route / history / boundary examples | 18 / 87 | [route](pr2-sessions-review-4ee4f448-route-first.log) |
| Ordinary Agent interface / journey | 21 / 59 | [agents](pr2-sessions-review-4ee4f448-agents-first.log) |
| Sidekick storage / recovery / configuration | 17 / 96 | [recovery](pr2-sessions-review-4ee4f448-recovery-first.log) |
| Entries / execution / controls / output | 45 / 177 | [entries](pr2-sessions-review-4ee4f448-entries-first.log) |
| Ordinary journey / forms / layout / source reading | 71 / 223 | [ordinary](pr2-sessions-review-4ee4f448-ordinary-first.log) |
| Execution / lifecycle | 6 / 39 | [lifecycle](pr2-sessions-review-4ee4f448-lifecycle-first.log) |
| Both unchanged Preview probes | 2 / 4 | [probes](pr2-sessions-review-4ee4f448-probes-first.log) |

Seven selections total **206 tests / 779 steps**, plus two unchanged probes /
four steps, all green. No L2/U2 intermittence or environment limitation recurs
in these runs. Their existing flake records remain open. The Implementor's
reported check = 0 and base lint limitation are noted, not independently rerun
or used as feedback prerequisites. No CI or complete runtime battery is used.

The Implementor reports all three assigned mutations restored byte-identically.
The first begin-notification arm did not discriminate; the replacement held
automatic follow-up is a conforming representative of the already frozen
no-input begin boundary, and its reported regression/control result is accepted.
That substitution does not fill the other SS1/SS7 observation gaps.

## Diagnostic provenance and adaptations

An initial mounted off-window probe attempted nine messages and both arms hit
the population failure before navigation. Its
[first output](pr2-sessions-boundary-probe-4ee4f448-first.log) is preserved.
Reducing that diagnostic to five messages then failed at pointer/navigation
readiness in both arms; that
[output](pr2-sessions-boundary-probe-4ee4f448-five-messages.log) is not treated
as a discriminating reveal proof. The separate measured reveal probe above
isolates the absent destination-window defect. Its first invocation had a
Planner import error for NO_LIFECYCLE, preserved in
[the compile output](pr2-sessions-reveal-probe-4ee4f448-first.log); correcting
that probe import produced the cited regression/control runtime result.
These diagnostic edits do not change the reviewed implementation and are not
evidence of product intermittence.

Mechanical sidekick: undefined fixture additions preserve older locations.
The approved two-section empty-state adaptations and safe handling of the new
saved item are consistent with the ruling. Existing interrupted-record claims
continue to distinguish an inert saved turn from an evaluated reply. These
adaptations are accepted; they do not substitute for missing mounted evidence.

## Disposition

Correct SS-P1–SS-P3 and complete SS-E1 under the same architecture and frozen
SS1–SS7 matrix. The prompt adds only three reproduced regression/control pairs,
not a new design or permutation battery. Re-run the seven selections, both
unchanged Preview probes and the three new probes after correction. Preserve
4ee4f448 and return a new signed feedback commit for review.

The implementation remains clean at 4ee4f448; no Planner production edit,
commit, push, GitHub mutation, CI inspection, capture, dependency or shared-cache
change was made. Sessions remains unaccepted. Preview stays accepted at
10b17a40. Full terminal acceptance, the 36-frame packet and delivery stay deferred.
