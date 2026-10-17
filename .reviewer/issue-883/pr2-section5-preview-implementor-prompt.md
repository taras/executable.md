# Implementor assignment: show streamed Sidekick Preview

**Closed: PASS at 10b17a40, 2026-10-14.**
[The review](pr2-preview-planner-review-10b17a40.md) accepts the bounded Preview
slice and closes PV-P1/PV-E1. No correction is currently assigned. Hold signed
clean 10b17a40fb07eb2fe623c9b4e4a5259d0501fe9a for the next Planner assignment;
do not restart the historical instructions below. Deferred work and delivery
remain outside this assignment.

**Current action at f8b4e035, 2026-10-14:** execute
[the narrow correction](pr2-preview-implementor-correction-f8b4e035.md).
The collision and most evidence findings are closed; failed-settlement identity
and one held-return observation remain. Preserve the exact signed head and its
ancestors. The older assignment/correction entries below are historical.

**Current action, 2026-10-14:** feedback at b44098ff is REQUEST CHANGES.
Execute [the correction prompt](pr2-preview-implementor-correction-b44098ff.md)
from that exact signed head. Do not restart at 81523318. The original assignment
below preserves the frozen scope and completed architecture decisions.

Implement this bounded #883 PR 2 slice from signed clean
`815233183c7c26cd40544347191b7ba5e1f975c3`, parent
`57773de05246578da77c0f8689fbee004cbd84b4`, branch agent/issue-883-pr2, in
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`.
Verify HEAD/tree; preserve signed ancestors and unrelated work. Reconcile any
advancement without reset, amend or discard. Follow .agents/implementor.md and
the repository instructions.

Read the full frozen plan and Architect ruling from the main checkout:

- `/Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-section5-preview-planner-handoff.md`
- `/Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-section5-preview-architect-decision.md`

PV1–PV5, three discriminating controls and ten final focused commands are
frozen. No new product interview or architecture choice is pending. Local
helpers and detached view field names remain delegated within these boundaries.

The person sees literal top-level Output as Preview while generation arrives.
No candidate control runs then. Preview stays in the same item during response
execution; acknowledged evaluated Output replaces it on settlement. Provider
failure or Stop leaves Incomplete, with no invented saved turn. Evaluated
runtime failure instead shows actual partial Output and retains earlier effects.
Computed text waits, controls-only body is not chat and feedback stays separate.

Required work, in order:

1. Add AgentPromptObservation in Core's agent/publication.ts with immutable
   `begun: AgentPromptHandle` and `text: string | null`; export it through
   core/host.ts only. Add optional
   `observe?(observation: AgentPromptObservation): Operation<void>` to the existing
   publisher. useAgentPromptPublisher remains the installation; observe without
   begin refuses before a turn starts. Old publishers retain optional begin.
2. In runPrompt's existing canonical consumer, accumulate text_delta source
   only for observing publishers. Before inline awaited observation, clear the
   whole candidate with package-private clearsLiveOutput in the owning execution.
   A differing final stream return also replaces the candidate exactly, including
   empty text; do not modify the journal's return value. Findings or unavailable/
   counterfeit/failing policy send null, withdraw earlier text and withhold
   further source for this turn. Continue consumption; the durable gate owns
   definitive persistence failure. No second subscription or detached queue.
3. Carry an observe exception past the ordinary provider-failure catch and
   journal result serialization to the existing activateFailure path, through
   a narrow Core-private marker retaining the original failure. Join provider
   cleanup; append no fabricated failed-provider Prompt and evaluate nothing.
   Null is not an exception. Preserve auditing, checkpoints, exact publication,
   direct provider routing and nonobserving behavior. No new public error family,
   scanner/policy export, Agent middleware or provider decorator.
4. In owner.open(), install a publisher inside each held conversation's execution.
   Its publish invokes the supplied append exactly once. Before respond() calls
   handle.prompt(), synchronously register its existing ResponseAt/live slot;
   cleanup must be established before prompting. begin consumes that registration,
   returns a fresh object and maps it privately by exact identity. observe and
   publish use that same handle; each automatic turn gets its own. Match neither
   input text nor predicted turn numbers. Add no suspension between the current
   preference read and prompt handoff.
5. Expose detached literal Preview facts through the owner and existing changes
   wake stream. Keep raw source, host handles, writer and append out of UI facts.
   Use previewGeneratedXmdRoot on cleared whole prefixes; a parse refusal removes
   the body. Keep live facts outside the acknowledged history projection. Merge
   the exact acknowledged turn and evaluated response into one stable mounted
   item/key; never mount duplicate live and retained replies.
6. Stop/failure/replacement revoke their response slot. A stopped generation
   with no saved record keeps only process-local Incomplete and claims no turn,
   acceptance, response or invented failure. A canonical failed record supplies
   safe literal Incomplete/reason on cold reads, using the pure reader and the
   existing restored-disclosure contract. Cold reading writes nothing and asks
   no provider. New explicit work cannot receive stale old notifications. Keep
   actual effects/unfinished records when stopping during evaluation; preserve
   admitted entry independence and the existing fatal refusal path.
7. In program.ts/application.ts, compose and draw those detached facts using
   the existing mounted tree/window/focus owners. Background updates require no
   terminal input and steal no focus or route. Preserve both composers, draft
   takeover, questions/Configure, History, footer, all layouts and hidden-target
   rules. Extend the existing fake-acp.ts for incremental held-after-delta turns;
   use mounted-program.ts, existing owner/Core fixtures and real persisted results.
8. Complete PV1–PV5 and their three controls. Align affected host API/publisher/
   private clearing comments, specs/executable-mdx-spec.md, specs/repl-spec.md and
   architecture.md. Describe implemented behavior, including the obsolete
   busy-only generation sentence. No guide/bootstrap/vocabulary change, parser
   implementation, new terminal host, journal grammar or provider API change.

PV1 proves no early effects, no-input Preview, held evaluation and same-item
final/partial replacement with separate feedback. PV2 proves representative
canonical prefix splits, distinct handles and exact differing/empty final
return. PV3 pairs generation failure with Stop, cold versus transient Incomplete,
joined cleanup/entry independence and fresh explicit work. PV4 proves accumulated
split-secret withdrawal and owning-execution policy, with cleared/authentic
controls. PV5 proves installation validation, authoritative observer failure,
no fabricated result, exact nonthrowing publication/audit/checkpoint and replay
silence. Use the plan's precise destinations/observations, not a second matrix.

Three mutations: drop only the observation wake; scan deltas instead of whole
prefixes; convert observer exceptions into provider failures. Each regression
must fail while its named control stays green. Confirm the mutation before
interpreting output, preserve first output and restore byte-identically. Prior
Configure/Apply/direct-provider mutations need not be repeated. Keep all accepted
permanent rows intact and report every fixture/assertion adaptation.

Run these commands from the worktree after the final edit:

```sh
deno task test packages/core/tests/agent-function-components.test.ts packages/core/tests/agent-conversation.test.ts packages/core/tests/agent-components.test.ts packages/core/tests/agent-session-launch.test.ts
deno task test packages/core/tests/generated-xmd-preview.test.ts packages/core/tests/secret-detection.test.ts
deno task test packages/acp/tests/host-conversation.test.ts packages/acp/tests/loaded-copy.test.ts
deno task test packages/workflow/tests/workflow-agent-checkpoints.test.ts packages/cli/tests/workflow-agent.test.ts packages/cli/tests/workflow-agent-sessions.test.ts
deno task test packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts
deno task test packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-agent-execution.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-output.test.ts
deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts
deno task test packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-agent-journey.test.ts packages/cli/tests/repl-forms.test.ts
deno task test packages/cli/tests/repl-route.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-source-reading.test.ts
deno task test packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-lifecycle.test.ts
```

Preserve first failure output before reruns. Known U2 intermittence has its
separate local record; report any recurrence and unchanged rerun, do not weaken
its assertion or include unrelated repair. Do not log rejected source, secret
matches or scanner/observer exceptions through a fallback diagnostic.

Commit promptly with signing enabled once the focused matrix, controls and ten
commands pass. Return exact SHA, parent, branch, signature, clean/untracked
status, every command/result, PV mapping, mutation results and adaptations.
Full suite, check/lint/JSR, packaging, captures and CI are not prerequisites.
Continue to that signed handback with progress updates; do not end after
individual files/rows. Return early only for a concrete contract conflict,
with evidence of which settled boundary cannot be implemented or proven.

No Sessions integration, complete terminal acceptance, 36-frame packet,
dependency/build change, main-checkout production edit, push, GitHub write or CI
inspection. Configure/Retry and all prior accepted slices stay closed. Stop for
Planner review of the signed feedback revision before opening another slice.

Continuity: exact base 815233183c7c26cd40544347191b7ba5e1f975c3; governing artifacts
are the linked frozen plan and completed Architect ruling. Interface, ownership,
disclosure, failure and Incomplete behavior are settled. No blocker remains;
next action is implementation and one signed Preview feedback commit.
