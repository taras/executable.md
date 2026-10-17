# Implementor assignment: Configure Sidekick and retry a failed message

Feedback at d4f38f6e is REQUEST CHANGES. Execute
[the correction prompt](pr2-configuration-implementor-correction-d4f38f6e.md)
from that exact signed head; do not restart at bb60ca35. This original prompt
records the frozen scope and decisions, not the current starting revision.

Implement the next bounded #883 PR 2 slice from signed clean
`bb60ca35661c2988ef647cc7a456470482d06e2e`, parent
`2f3af332e09a7aa8e6acda6e51e1f63aab13614e`, branch agent/issue-883-pr2, in
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`.
Verify HEAD/tree; reconcile any advancement without reset, amend or discard.
Follow .agents/implementor.md and current repository instructions.

Read the full frozen plan in the main checkout:
`/Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-section5-configuration-planner-handoff.md`.
Also read its governing timing and product decisions. CFG1–CFG9, three
discriminating controls and six exact feedback commands are frozen there.
The plan names source seams, mounted presentation/acknowledgements, authorized
R7 changes, failure/cancellation behavior and documentation work. The questions
raised during preparation are settled; do not repeat that interview or delegate
those choices to implementation.

What the person gets: Configure in the Sidekick header, real agent/model/effort
selection, requested versus last verified settings, preferences saved during
current work for the next turn, and explicit Retry of a saved failed message in
the same conversation. Apply saves and closes on success; Close discards
unapplied choices; failed Apply stays open with its reason.

Required work, in order:

1. In sidekick/history.ts, serialize the existing SidekickWriter's physical
   append plus in-memory acknowledgement for every caller. Keep its ordered
   acknowledged read as the one source. A waiting cancelled append writes
   nothing; an admitted physical append joins publication/failure before
   release. Do not serialize provider prompts, evaluation or entry waits.
2. In sidekick/owner.ts, configure() saves a complete preference for the captured
   active conversation while busy without holding(), inspecting or stopping
   the provider. Refuse a busy initial setup with no active target. Keep idle
   explicit establishment. Read the latest acknowledged preference after
   message/feedback writes and acknowledgement, immediately before prompt
   handoff, with no intervening preparation/UI yield. Current turns retain
   their original scalar request. Apply the Architect's exact busy R7 adaptation.
3. In sidekick/model.ts, derive per-conversation Last verified from Core's saved
   PromptRecord.configuration. Preferences and inspection defaults are not
   verification; failed application supplies none. A started turn that later
   fails may still carry it. No new record or public Core API.
4. In program.ts, own one explicit configuration task at a time and reserve
   setup/inspection/Apply/replacement against conflicting Send before spawning.
   Permit an independent preference Apply alongside an existing message cycle.
   Stop does not cancel that save; replacement finishes or cancels/joins it
   before setup. Shutdown joins all admitted jobs/writes before writer/provider
   release. Ignore stale UI results by bound conversation/agent/model selection.
5. In application.ts and root intent handling, mount Configure/Refresh/Apply/
   Close through existing bounded choices, pane-local measurement and Freedom.
   Agent is an exact-name field. Preserve provider IDs/metadata/null support.
   Effort belongs to its selected model; busy uncached refresh is unavailable
   until explicit inspection, with model-only Apply permitted. No silent effort
   choice, deferred automatic inspection or native reset policy.
6. Different-agent Apply explicitly starts a new conversation, or says Stop
   and start new conversation while busy. Join first, then owner.select().
   Success closes; failed setup keeps prior association and shows its reason
   with the drawer open. Do not copy old-agent preferences/choices or replay
   old chat into the replacement. Switching sends no model prompt.
7. Retry resolves the exact failed person's saved request and rechecks active
   association/acceptance before starting. Pass its literal text through the
   existing owner.message() path with the same single-cycle reservation as
   Send. Preserve the prior attempt and unrelated composer text. Distinguish
   Retry's acknowledgement from composer consumption while keeping the existing
   draft-revision takeover and acknowledgement-before-fill rule. No sentinel
   revision, temporary composer replacement, guessed turn association or bypass
   of unknown-acceptance/identity/storage/configuration-integrity refusals.
8. Preserve bb60ca35's frame-derived modal/input ownership and route precedence.
   Hidden Configure has no targets; History closes itself once. Keep separate
   pending-question partial values, both composers, seven footer rows and
   default-versus-explicit resize behavior. All drawer state is process-local.
9. Complete CFG1–CFG9 through existing mounted-program.ts and transport/history
   fixtures. Align architecture.md/specs/repl-spec.md only for implemented
   behavior, including misleading owner/history establishment/reset comments.

Reuse the frozen finite pairs; no new settings/timing permutation matrix or
second terminal host. Report every fixture/assertion adaptation. Keep the
existing rejected-choice regression, accepted no-wait journeys, question rows,
R2 and normal Send/Stop assertions intact. Only the specifically authorized busy
R7 claim changes. Preserve first failure output before reruns. Verify each
mutation applied, preserve its output, restore byte-identically and rerun
affected evidence. The plan's six commands run against the final source.

When that focused evidence passes, commit promptly with signing enabled and
return exact SHA, parent, branch, signature, tree/untracked status, every command
and result, CFG mapping, mutation controls and adaptations. Do not wait for the
full suite, lint/check/JSR, packaging, captures or CI. Stop for review after the
signed feedback commit. Return a genuine existing-contract conflict rather than
introducing new authority, a provider route or weaker assertions.

Configuration P1/P2, direct-provider routing, identity/activation/recording,
R2 and the mounted message/question slices remain accepted. No Core/ACP public
interface, canonical component, record format, flag spelling, route codec,
dependency or vendored-runtime change is assigned. Preview, Sessions integration,
complete terminal acceptance and the 36-frame packet remain deferred.

No push, GitHub mutation, CI inspection, main-checkout production edit or real
terminal capture is authorized. Do not import unrelated main worktree edits.

Continuity: exact base bb60ca35; artifacts are this prompt and linked frozen
plan. Retry, Apply/Close and preference timing/ownership are settled; no blocker
remains for this bounded slice. Next action is implementation and one signed
feedback commit under CFG1–CFG9 and the six commands.
