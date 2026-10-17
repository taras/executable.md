# Planner review: first conversation-owner increment at e3aaa61e

REQUEST CHANGES at `e3aaa61e1977c5293842b5eba8a4505bd16b575d`, parent
`356f1b5164cc966cff92a0d5b6c5b554fc14e97d`, branch `agent/issue-883-pr2`.
HEAD matches, the signature verifies G for tarasm@gmail.com, and the
implementation worktree is clean. Two existing failure contracts are unmet.
The accepted read, guide, admission/Pause and Core increments remain closed.

## P1 — a failed provider turn makes its own history unreadable

At `packages/cli/src/repl/sidekick/owner.ts:407`, the failed-prompt path appends
a response record even though that canonical turn did not complete. The existing
projector deliberately refuses such a record: response outcomes belong to
canonical completed turns (storage-contract.md, Required retained records).

The next refresh therefore changes owner.reading to Err:

> this chat history holds a reply for a turn it never completed (record 11).

The owner has written a file its own reader cannot accept. This also prevents
explicit continuation: message() returns that stored projection refusal before
opening or sending anything (owner.ts:305). Cold projection encounters the same
invalid response record. This violates the accepted behavior that a terminal
provider failure leaves an Incomplete preview and pauses for explicit retry or
message, rather than invalidating the history.

The new provider-failure row checks the raw response record and unchanged draft,
but never checks owner.reading. It therefore passes while the newly written
history is unreadable.

Keep the completed-turn guard for admitted response outcomes. Failed provider
source is already retained in the canonical Prompt record; derive its Incomplete
preview from that account without inventing an admitted response. Preserve the
attempted turn ordinal so the next explicit turn advances past the failure.
This is a correction within the existing canonical-event/response distinction,
not a new durable record family or architecture decision.

## P2 — ordinary root failure discards its actual partial rendering

At `owner.ts:438–439`, every Err from evaluateGeneratedXmdRoot becomes
output="" and hasOutput=false. Core's GeneratedXmdRootError already carries the
actual partial GeneratedXmdRootResult when evaluation began. The owner ignores
it, records an empty response, and returns an empty result.

The focused scenario renders `Before.`, applies a real earlier fill `kept`,
then injects an ordinary failure at the next root fill request. The draft
correctly remains `kept`, but the owner returns empty output instead of
`Before.`. Later source does not need to run to recover the partial; Core has
already supplied it.

Preserve the canonical partial output and hasOutput in the retained response,
owner result and projected reply for ordinary generated-root failures. An
admission refusal with no partial remains distinct. Raised durability, policy,
Files and teardown failures keep their existing authoritative path. This restores
the accepted runtime-failure behavior and does not assign follow-up turns to
this increment.

## Reproducer and finite evidence

The [reviewer probe](pr2-owner-failure-probe-e3aaa61e.test.ts) reuses the new
journey's production repository, profile, conversation, response ceiling and
entry-session harness. Its only extra seam injects an ordinary error into a
later fill request. The first fill uses the existing real application transition.
No journal or evaluator is substituted.

[First output](pr2-owner-failure-probe-e3aaa61e.log) is preserved:
the successful two-turn control passes, the failed-provider projection case
fails, and the partial-rendering case fails. The first failing assertion is the
unreadable projection; its later retry assertions are not reached. The
message() early guard establishes why continuation is blocked.

From the implementation worktree:

```sh
deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-owner-failure-probe-e3aaa61e.test.ts
```

The [correction prompt](pr2-owner-failures-implementor-prompt.md) supplies the
finite implementation and evidence threshold.

## Accepted implementation and scope

The execution-owned resource projects existing history at acquisition and opens
no conversation until an explicit message. Fresh conversation preparation and
successful activation are retained, the handle is held in the owner's scope,
and a second live message is refused rather than queued. The profile and root
read surface remain separate.

The per-response ceiling and submit binding now carry the exact conversation
and response identity. Delegating Submit journaling to the existing root
admission helper is accepted: readiness, writer settlement and reservation
precede its one intent, and the root retains the one outcome. The wrapper must
not write a second intent before those terms exist. The real submit journey
proves one pair alongside the EntryInput pair.

The orientation is composed from shipped bootstrap, derived guide index and
compact admitted surface, with exact-byte digests. The draft accompanies each
turn. The same-conversation second turn omits initial orientation after a
canonically completed first turn. Attempted ordinals come from canonical names;
failed attempts still consume their ordinal.

Deferring program.ts acquisition until its message actions have a consumer is
accepted as sequencing for this increment. When bound, the owner still belongs
to the execution scope, independently of tabs and pane mounting. The current
journeys use a fixture implementation of the root's fill/application behavior;
they do not prove the program's queued fill path.

The explicit omissions remain incomplete: designated-result follow-up, Stop,
Sidekick-owned Elicit, configuration, compatible metadata refresh, live preview
and terminal binding, R2 cases 2/5/6, and remaining R3/R4/R5–R8 evidence. The
first-turn-only implementation does not supersede the accepted compatible
refresh contract. Section 4 and the full CLI slice are not complete.

## Independently executed commands

All commands below use `deno task test` with files under packages/cli/tests/:

| Selection | Result |
| --- | --- |
| repl-sidekick-storage.test.ts repl-sidekick-recovery.test.ts | 9 tests, 43 steps; pass |
| repl-sidekick-controls.test.ts repl-sidekick-output.test.ts repl-history.test.ts repl-entries.test.ts | 38 tests, 157 steps; pass |
| repl-sidekick-journey.test.ts repl-agent-journey.test.ts repl-forms.test.ts repl-lifecycle.test.ts repl-source-reading.test.ts | 22 tests, 130 steps; pass |
| cli-help.test.ts repl-layout-admission.test.ts repl-exit-pty.test.ts repl-presentation-style.test.ts | 21 tests/76 steps pass; 1 test/2 steps fail |
| repl-journey.test.ts repl-agent-interface.test.ts | 53 tests, 111 steps; pass |

The four green commands total 122 tests/441 steps. The terminal selection's two
failed steps are both in repl-exit-pty: tmux capture-pane reports that its private
socket no longer exists. The full first output is preserved in
`pr2-owner-review-e3aaa61e-layout.log`. No evidence links this failure to the
owner change, which has no program/terminal consumer yet; it is recorded as a
separate verification limitation, not a third owner finding. No rerun or
product-test rewrite was used to erase it.

Other logs are `pr2-owner-review-e3aaa61e-{storage,controls,owner,journey}.log`.
No full suite, CI inspection or GitHub mutation was performed.

## Continuity and next action

Reviewed base is e3aaa61e above accepted 356f1b51. Correct P1 and P2 and return a
focused signed feedback commit before continuing the next owner increment.
Preserve the accepted Submit delegation and orientation/ownership choices.
The artifacts are this review, its correction prompt, the probe and first
output, focused logs and the updated planner-handoff.md. No product or
architecture ruling is pending for these two corrections.
