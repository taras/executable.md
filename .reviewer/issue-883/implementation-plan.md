# Implementation proposal for #883

**Product Owner spelling correction, 2026-10-15:** use `--sidekick-agent` and
`sidekickAgent` throughout active implementation and instructions. This supersedes
the earlier exact-spelling instruction. Selection, ownership and persistence
contracts are unchanged. See
[the current correction](pr2-terminal-completion-implementor-correction-d634b28b.md).

This is preparation-time research and candidate implementation evidence.
[planner-handoff.md](planner-handoff.md) now supplies the completed accepted
architecture, Core interfaces, storage/recovery contract and product verification.
The packet is ready for the Planner to derive finite implementation acceptance.
Open-decision language below describes the earlier research stage and does not
override that completed handoff. The recorded #881 implementation gate remains.
[acceptance-proposal.md](acceptance-proposal.md) is provisional, not a frozen
implementation threshold.

The accepted [syntax discovery amendment](syntax-discovery-amendment.md) adds
progressive teaching/reference discovery to the completed handoff; use that
record for the initial context, guide/environment reads and amended J10/R5.

## Outcome and scope

A dedicated Agent conversation belongs to each retained REPL session and
reopens with that same session, as accepted in architecture-review.md. It
lasts across entry submissions. Bindings and
Sidekick share a tabbed right pane. The chat composer sends conversation; the
existing main input holds executable XMD. Complete successful Sidekick responses
are evaluated automatically. REPL controls inspect bindings, fill the shared
input without executing, and submit through ordinary admission. Output selects
the person-facing text; operation feedback and validated answers reach the
owning Sidekick separately.

Keep the spelling `--sidekick-agent` requested by the Story. `--default-agent`
continues selecting entry Agents. Sidekick-only agent/model/thinking selection is
accepted in the architecture review following Product Owner feedback; the
initial blanket deferral does not settle this selection surface. Broader settings/provider design,
general session management, History forks, native Agent TUI synchronization,
and a renderer/framework replacement are excluded. The reference's countdown,
edit-to-stop policy, source/feedback toggles and multiline editor are
demonstrations, not accepted requirements. The separate accepted default selects
Sidekick in the wide/medium right pane for a new session.

## Sources and base

Governing sources: Story #883; predecessor #881; Quest #827; repository AGENTS.md;
`.agents/planner.md`; `.agents/architecture-rules.md`;
`.agents/product-interface.md`; `.agents/product-verification.md`;
architecture.md; specs/repl-spec.md; executable-MDX sections 5.3.3 generated XMD,
6.5 bindings, 6.9 Output, 6.16 Elicit, execution installation, and Document Output;
the Agent session/Prompt contracts in specs/acp-client-spec.md and Core.
Effection's required v4 AGENTS.md was retrieved from its official repository.

Remote main is `20462295c2ac44305577359583be0a33004cc428` (#880). Local HEAD is
`2d719f78025059158a35023701fdff52b855a65b` (#878). A direct Git comparison finds
no delta in `packages/cli/src/repl/`, `repl-profile.ts`, or the REPL tests.
Main adds #879's terminology correction and #880's unversioned workflow
definition; do not carry the local file's superseded versioned-definition
language into new documentation. No checkout, branch or existing worktree was
changed by this preparation.

#881 is open. Its local PR 1 branch is at
`f0b8eb1f323c1ad5826eafba978ef9c2e9f5fffa`, based on
`e68f128121cd802623ab7797a016b0c66ce91176`. The saved Planner review requests
changes, and `.reviewer/issue-881/implementation-plan.md` still leaves lifecycle,
generated-source and History slices for architecture resolution. Another local
presentation worktree is at `62d4a0925b754bada39bbd048987db8f4d70278b`;
neither revision establishes complete original parity. Do not stack #883
implementation onto PR 1 and claim its predecessor complete.

The remote open PR list contains no #883 implementation or #881 delivery.
#802 is a Configliere evaluation marked not for merge; reuse the current CLI
parser instead of adopting its proposed API. #805 is disposable session-rendering
evidence, not a replacement production renderer. The terminal/native-session
stack and #742 Devin work are not prerequisites for the accepted Story.

Installed stack: Effection 4.1.0, context-api 0.6.0, tty 0.9.0,
@effectionx/fs 0.3.0 and CLI/Core 0.13.1; Freedom is the repository's pinned,
patched vendor snapshot. No dependency change is presently indicated.

## Current behavior and consequences

| Boundary | Repository evidence | Consequence for Sidekick |
| --- | --- | --- |
| CLI/profile | `cli.ts` defines five shared Agent flags and explicitly refuses other REPL options. `repl-profile.ts` assembles one entry profile once. | Add the REPL-only option to definition, explicit grammar, dispatch, help and tests. Resolve fallback and configuration failure timing first. |
| Root state | `repl/application.ts` owns draft, route, selection, form and windows. `program.ts` reduces actions and performs effects. | The shared input cannot be a second Sidekick-owned text buffer. Agent controls need typed requests handled at the root. |
| Admission | `application.ts` refuses submission at a frozen History position. `session.ts` checks lifecycle before and after preflight and synchronously occupies the entry slot. | Calling `session.submit()` alone bypasses the root's History guard. Both authors must traverse the same root admission decision. |
| Completion | `session.submit()` returns admission; `session.join()` waits for the held entry and teardown. A retained Close alone does not free occupancy. | Feedback must distinguish accepted submission from execution outcome and identify the exact entry, rather than reading whichever entry is current later. |
| Draft clearing | `program.ts` clears the draft after asynchronous admission through `admitted(state)`. | A second writer makes source/revision correlation material. An earlier completion cannot clear a newer human draft. |
| Bindings | `model.ts::entryInitialBindings()` derives root values from acknowledged durable history; selection can show another entry/scope/prefix. | The agent's inspection source must be specified independently of what the pane happens to display. No direct access to a live eval environment is needed. |
| Agent observations | `agent.ts::owning(entry)` creates an entry attachment; ordinary Prompt publication transfers its live slot. Direct `Agent.prompt()` is deliberately not journal-observed. | The existing observer cannot merely receive a fake entry key for Sidekick. Define a separate owner and truthful Sessions attribution. |
| Agent transport | Core's `Agent.prompt()` returns a cold stream; subscription starts one provider turn in the subscribing scope. | Subscribe once under the Sidekick owner. A display subscription cannot also start the turn. Evaluate only the complete successful response. |
| Elicitation | `elicitation.ts` has one pending question per provider instance, schema validation, and scope-bound removal. Entry questions currently own an Entries-only drawer. | Give Sidekick questions their actual owner. Do not let an entry question and Sidekick question overwrite one singleton or share an answer target. |
| Generated evaluation | `Evaluate` preflights complete untrusted source under one captured host profile. The ordinary REPL profile admits no REPL controls. | Automatic evaluation needs an explicit Sidekick ceiling and exact control identities. Do not run provider text as a trusted ordinary root with eval/exec permissions. |
| Output | Output regions select ordinary rendering and buffer until completion; without Output the whole body ordinarily renders. Evaluate renders fragment output only. | No streaming-progress reinterpretation. Specify responses without Output and keep host operation feedback outside generic Evaluate rendering. |
| Journal | `entries.ts` requires consecutive root-import-to-root-Close segments. Work between entries is malformed. | Appending Sidekick Prompts or responses directly to this physical stream is invalid. Separate retained Sidekick history linked to the REPL session is accepted; exact records, correlation and compatibility remain under architecture review. |
| Presentation | One measured/admitted tree determines output, focus and pointer targets. At 72×20 the inspection column is absent. | Tabs cannot own work, hidden content cannot retain input targets, and narrow Sidekick access requires an explicit product adaptation. |
| Cold reconstruction | Settled history projects without execution/provider calls; only an unfinished final entry resumes. | Reopening restores the same Sidekick and its saved conversation without a new turn or response execution. Explicit continuation is accepted; normal entry resumption remains independent. |

## Ownership that is already settled

The REPL root owns application state and admission. Sidekick controls send
semantic requests to it. Presentation receives immutable views and returns typed
actions through mounted ancestry. Freedom alone owns focus. Measure, admit,
reconcile and draw continue using the same engine and builder.

An admitted entry owns its own execution, outcome and teardown. Entry source is
immutable and entries remain sequential. A Sidekick cannot queue past a running
entry, skip unfinished teardown or submit from read-only History. Tab changes
neither cancel work nor select another entry/history position. Background
inspection does not steal keyboard focus.

Shared production code uses contextual host APIs, Effection generators and
scope-owned resources. Register cleanup before acquiring native resources or
listeners, subscribe before spawning producers, and observe cancellation joins.
Return Effection Result with `value` for success and Error for failure. Local
names and helpers remain Implementor decisions after contracts are accepted;
do not extract a general REPL automation package without a concrete boundary.

## Proposed delivery order

Architecture/Product Owner acceptance and complete #881 delivery precede these
layers. Refresh the exact base and read the complete architecture on that base
before freezing the final plan. Each slice's shipped spec must match its actual
behavior. This is a candidate stack, not a settled PR boundary.

1. **Control boundary.** Implement the accepted contextual/host route for
   bindings, entry-output reads, input replacement and submission in private CLI modules. Reuse the
   root reducer and admission, preserving draft bytes on refusal. Return a
   correlated completion for the admitted entry only after teardown. Prove the
   admission and draft-race invariants with real sessions. An isolated tested
   host seam may land without advertising an unavailable Sidekick UI.
2. **Conversation and response ownership.** Add one root-owned Sidekick session,
   cold-stream consumer, complete-response evaluation, feedback routing and
   Elicitation ownership. Scope it independently of entry tasks and tab content.
   Implement only the accepted persistence policy. Prove real binding-to-draft-
   entry-to-feedback round trips and cancellation before exposing the feature.
3. **Complete terminal feature.** Add `--sidekick-agent`, tabbed right-pane views,
   separate chat input, pending-work cues and the accepted narrow route. Keep
   content, inputs and targets consistent under tab switch/resize. Capture the
   complete production journey and write the delivered specification.

The Architect must confirm whether layers 1 and 2 can merge independently
without temporary public contracts. Otherwise deliver one coherent feature PR
with those as review sections. No unfinished UI-only Sidekick slice closes #883.

Candidate affected files are `packages/cli/src/cli.ts`, `repl-profile.ts`,
`repl/program.ts`, `repl/application.ts`, `repl/description.ts`,
`repl/components/actions.ts`, `repl/components/rows.ts`, `repl/layout.ts`,
`repl/layout-admission.ts`, `repl/route.ts`, and the private owner/control modules
their concrete consumers require. `session.ts`, `agent.ts`, `model.ts` and
`elicitation.ts` change only for the accepted boundaries above. Storage and
runtime adapters change only if an accepted durable contract requires it.
`renderer.ts`, tty and Freedom need no feature semantics. Core changes require
a demonstrated missing canonical boundary and explicit architecture resolution.

## Evidence, feedback and delivery

The candidate evidence matrix and existing regression files are in
acceptance-proposal.md. No new acceptance IDs or commands are frozen yet.
No runtime tests were run: this preparation changes no implementation and makes
no claim that Sidekick behavior already passes. No dependencies were installed.

After approval, the Planner binds each accepted criterion to finite scenarios,
exact focused commands, slice ownership and production terminal captures.
The Implementor commits promptly once that focused evidence passes and returns
the exact SHA, parent, commands and results. It returns an inability to prove a
criterion rather than inventing a replacement behavior or extending acceptance.
Preserve the first failure before rerunning and follow the flake issue rule if
an unchanged revision passes on retry.

Required CI and `green` own delivery's exhaustive runtime shards, typechecks,
lint, JSR and site checks. Full local runtime suites are unnecessary unless a
changed shared boundary defeats affected-test selection. Use explicit regression
files for subprocess/generated/dynamic boundaries. If dependency/build ownership
changes, commit first and run verify:clean as required by AGENTS.md. New test
files or changed runners/exclusions require measured runner weights after the
corpus settles; never hand-edit milliseconds.

## Documentation and recovery

Update specs/repl-spec.md for CLI options, two input destinations, tabs, control
behavior, binding selection, feedback, elicitation, lifetime, cancellation,
History and cold reconstruction. Update architecture.md's private REPL section
and terminology only for accepted new boundaries. Keep generic Output/Elicit
and Evaluate semantics in their existing specifications; document any genuinely
new language contract alongside its mechanics and tests. Read the component
description guide before authoring control descriptions and review the internal
agent instructions as product interfaces.

The accepted session-owned Sidekick requires a persistence and resume contract.
The Architect specifies recognition, refusal and rollback before implementation
or removal can make a compatibility claim. The primary risks are two writers losing the draft, feedback
correlated to the wrong entry, a chat owner blocking the root while it awaits a
question/result, tab-owned cancellation, and provider text escaping generated
admission. The proposed evidence targets these boundaries directly.

## Continuity

Exact research base: `20462295c2ac44305577359583be0a33004cc428`; local REPL
inspection: `2d719f78025059158a35023701fdff52b855a65b`, with identical relevant
files. Artifacts: this proposal, README.md, architect-handoff.md,
acceptance-proposal.md and reference/ under `.reviewer/issue-883/`.
Settled decisions: #883's explicit experience and root/presentation/entry
ownership only. Blockers: the Architect handoff's unresolved contracts,
approved product verification/reference adaptations, and full #881 parity.
Next Implementor action: wait for the accepted architecture and frozen Planner
handoff; begin no production changes from this proposal.
