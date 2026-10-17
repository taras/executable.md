# Implementor assignment: read Sidekick work through Sessions

**Closed: PASS at ab681d4a, 2026-10-15.** [PASS review](pr2-sessions-planner-review-ab681d4a.md) accepts Sessions and
all remaining evidence corrections. Hold at signed clean
ab681d4acd824665188f2c6ab9997eecbbf178e0. No new Implementor work is assigned;
do not execute the historical prompts below. Full terminal acceptance, captures
and delivery need their own bounded assignment.

**Current action at 5ce2e2d2, 2026-10-15:** execute
[the remaining evidence correction](pr2-sessions-implementor-correction-5ce2e2d2.md).
SS-P1–SS-P3 are closed; keep their fixes. Most SS-E1 evidence is accepted;
the review names the finite remaining observations and new cast removals.
Preserve the exact signed head and ancestors. Older instructions below are
historical; do not restart from 4ee4f448 or 10b17a40.

**Current action, 2026-10-15:** execute
[the correction prompt](pr2-sessions-implementor-correction-4ee4f448.md) from
signed clean 4ee4f44824ce39f41385e70cce107bd0d110ec6c. Preserve that feedback
commit and its parent. The original implementation instructions below retain
the accepted scope and frozen matrix; do not restart from 10b17a40.

Implement the bounded Sessions slice of #883 PR 2. Sessions shows **Entry
agents** and **Sidekick** in separate ordered sections. Selecting a Sidekick
turn opens its chat and reveals it. Previous chats are read-only, reopen through
`sidekick=<saved-chat-id>`, and offer **[Back to current chat]**.

Follow `.agents/implementor.md` and repository instructions. Start from signed
clean `10b17a40fb07eb2fe623c9b4e4a5259d0501fe9a`, parent
`f8b4e035382e22cf0f19b743dcb3b26f3bd4cc02`, branch agent/issue-883-pr2, in
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`.
Verify HEAD/signature/tree first. Preserve signed ancestors and unrelated work;
account for advancement without reset, amend or discard. Main has unrelated
edits and is not the implementation base.

Read these main-checkout records in full:

- `/Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-section5-sessions-planner-handoff.md`.
- `/Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-section5-sessions-architect-decision.md`.

The decision is complete. **SS1–SS7, the three discriminating controls, seven
focused selections and two unchanged Preview probes are frozen** in the plan.
Ordinary private shapes/helpers are delegated; no new product choice belongs
to the Implementor. Preview and previous accepted increments stay closed.

Required implementation, in order:

1. Extend sidekick/model.ts's pure reading with actual canonical turn facts
   across all chats, using parsePromptRecord() and the existing request-boundary
   reader. Save no new record. Keep own agent, status, actual provider key when
   present, associated saved person text or Automatic feedback, and evaluated
   outcome. Do not publish machine inputs or generated control source. Failed
   source follows the accepted safe incomplete reader. A completed Prompt with
   no evaluated response has the inert status **Turn saved; no evaluated reply
   recorded.**
2. Extend owner.ts's existing one publisher/changes path. Begin announces a turn
   even with no Output. Keep exact begin-handle/registered-response correlation,
   cleared observation and one append. Actual publication association supplies
   only its own live key; acknowledgement replaces the same row once, and later
   evaluation updates it. Stop with no saved Prompt invents no saved turn or
   acceptance. Preserve the accepted Preview identities and late-update guards.
3. Add only the approved ReplRoute member `sidekick: string | undefined` and
   `sidekick=` query after existing members, with percent encoding and strict
   empty/duplicate/malformed refusal; no chat= alias. Resolve an exact saved
   CLI association, including prepared/failed setup with no provider key.
   Unknown/unreadable history refuses. Old locations remain byte-identical.
   Extend resolvable() before openReplSession(): invalid old-chat locations must
   not resume an unfinished entry or start a provider before refusing.
4. Compose separate entry-prefix and current Sidekick facts at the root for
   route resolution, measurement and drawing. session remains an actual
   provider-key filter across both sections. A saved Sidekick key or exact live
   publication key remains applicable beside frozen entry History; an entry-only
   later key does not. All includes unknown-key turns, equal keys offer one
   filter and two distinct owner rows. Sidekick never enters ReplModel and
   receives no fabricated entry key or History marker.
5. Draw Entry agents then Sidekick, preserving each order and entry-only behavior
   without a Sidekick installation. Render refusal rather than fake emptiness.
   Add semantic turn-selection/Back actions through existing components and root.
   Activation sets view/right to sidekick and the exact saved chat ID, preserves
   the left surface, filter, scopes, History and drafts, and reveals its actual
   turn using process-local measured window navigation. Give turns without a
   rendered reply inert anchors, not new person messages or history records.
6. Separate selected chat from active owner. Omission follows current; explicit
   ID pins the reading. Active chat keeps usual controls; other chats contain
   no composer, Send, Retry, Configure, pending-question or Stop targets. Hide
   current-chat modal presentation there without losing partial question fields.
   Back is outside the transcript window, clears the selector, keeps Sidekick
   selected and restores the current message draft. Existing pane/surface
   changes retain the selector. Background updates/resize never retarget it.
   Matching successful agent replacement returns to the new current chat;
   failure preserves reading/association. Preserve late-report revision guards
   so a newer deliberate reading is not overwritten.
7. Complete SS1–SS7 with real mounted/owner/file boundaries and the explicitly
   permitted pure canonical-record cases, run the three controls, align
   specs/repl-spec.md and architecture.md, then run the final focused selections
   and both unchanged probes exactly as listed in the plan.

Use the real runReplProgram/profile/repository/session/owner with the existing
mounted-program.ts harness, fake-acp.ts and genuine append/provider gates.
No sleep establishes readiness. Before/after identity observations must come
from real owner facts, not a snapshot built from a future record. Mechanical
route fixture additions and the explicitly approved two-section assertion
adaptation are allowed and must be reported; no assertion is weakened.

No Core/ACP interface, provider routing, storage format, native permission UI,
new clock/order record, second publisher/subscriber, generic registry/framework,
renderer validation relaxation, CLI flag, dependency or vendored-code change.
No authored Promise synchronization or type casts. Register cleanup before
acquiring resources and keep all changes in the correct owning scope.

Continue through routine layers with concise updates; do not stop for another
go-ahead at each checkpoint. Return a concrete conflict if the ruled boundary
or frozen evidence cannot be implemented; do not silently substitute it.

Preserve first failure output before any rerun. Report genuine unchanged
intermittence against the existing L2/U2 records; do not claim a rerun fixed it.
No shared-cache or dependency repairs. Broad lint/check/JSR, complete runtime
suites, packaging and CI are not prerequisites for the feedback commit.

Once the frozen evidence passes, promptly create one signed feedback commit
above the exact base. Hand back SHA/parent, branch/signature, clean/untracked
status, diffstat, every focused command/result, SS mapping, control results,
adaptations and limitations. Stop for review of that exact commit. No push,
GitHub write, CI inspection or capture. Full terminal acceptance, the 36-frame
packet and delivery remain separate assignments.
