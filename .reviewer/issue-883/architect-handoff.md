# Architect working handoff for #883

**Product Owner spelling correction, 2026-10-15:** use `--sidekick-agent` and
`sidekickAgent` throughout active implementation and instructions. This supersedes
the earlier exact-spelling instruction. Selection, ownership and persistence
contracts are unchanged. See
[the current correction](pr2-terminal-completion-implementor-correction-d634b28b.md).

This is the preparation-time working record. The completed accepted contract is
[planner-handoff.md](planner-handoff.md), with accepted Core interfaces in
core-interfaces-proposal.md and derived storage mechanics in storage-contract.md.
Its completed readiness supersedes open-decision language below.
The accepted [syntax discovery amendment](syntax-discovery-amendment.md) also
supersedes this working record's full initial syntax delivery with a short
bootstrap and on-demand guide/reference reads.

Prepare the accepted design for an interactive Sidekick in `xmd repl`. A person
discusses a task; the Sidekick reads actual bindings, fills the shared entry
input, submits through normal admission and revises from the actual result.
The chat lives in a right-pane tab; its owner survives tab changes and entry
submissions.

Read [Story #883](https://github.com/taras/executable.md/issues/883),
[the Planner's findings](implementation-plan.md),
[the verification proposal](acceptance-proposal.md) and
[the local reference record](reference/README.md). Apply `.agents/architect.md`
and the architecture, product-interface and product-verification rulebooks.
Read the complete architecture, REPL spec and affected XMD/Agent contracts at
the resolved base. Do not implement or mutate GitHub from this handoff.

Research main is `20462295c2ac44305577359583be0a33004cc428`.
The inspected local REPL at `2d719f78025059158a35023701fdff52b855a65b` is identical
to main in relevant production/test files. Full #881 parity is a required
predecessor; its PR 1 feedback SHA is not the accepted #883 implementation base.
Resolve the eventual base again after #881. No accepted #883 decision amendment
was found, and the issue has no comments at preparation time.

## Keep the accepted contracts

Keep the dedicated conversation, Bindings/Sidekick tabs, independent chat and
program inputs, automatic evaluation of complete responses, root-owned
admission, ordinary sequential immutable entries, independent user output and
agent feedback, contextual schema-backed Elicit, and the requested
`--sidekick-agent` spelling. Preserve `--default-agent` for entry Agents.
Inspection/background activity changes no tab, entry, history position or focus.
Tab switching keeps chat text, shared draft, conversation, interactions and work.

Keep visible continuous column dividers, distinct dark pane backgrounds,
stronger header bands and a full-width History footer boundary. The fixed
browser canvas and scripted controls settle no terminal or runtime behavior.
Exclude broader settings, session management, History forks, native TUI
synchronization and renderer/framework replacement.

## Review the system boundary before individual names

This feature adds several meaningful operations, a feedback channel, an Agent
owner and potentially storage outside sequential entry execution. That triggers
the Architect's system-boundary interview. Inventory the binding/output reads, draft-write,
submit, completion, elicitation, cancellation and inspection members with their
owners and lifetimes. Review them with the Product Owner one at a time. Accepted
decisions are identified below and in architecture-review.md; recommendations
and unfinished record/engine boundaries remain open.

### 1. Lifetime, retention and inspection

**Current.** The physical REPL Journal contains only sequential entry ranges.
Appending a chat Prompt between them fails partitioning. The existing observer
attaches turns to an entry; direct Agent.prompt calls create no retained
Prompt reading. Cold settled inspection contacts no provider.

**Accepted retention decision.** Each REPL session owns its own Sidekick;
reopening the same session reopens the same Sidekick conversation. Its identity
belongs to the retained execution rather than a command invocation. This
supersedes the initial invocation-only recommendation. Define the source of
truth, persisted identity association, provider resumption, retained chat,
interruption recovery and compatibility before implementation. Do not append
between-entry chat to the existing entry Journal or select storage as an
Implementor convenience. See architecture-review.md for the decision record.

**Accepted inspection decision.** Sidekick remains a live conversation while
an entry's History is inspected. The execution projection is historical;
Sidekick is current. Chat and draft preparation remain available, while ordinary
entry admission refuses submission until the person returns to Live. Binding
selection remains item 4's decision. Reopening restores Sidekick and waits for
explicit continuation; it starts no additional Sidekick turn or response
execution. Already admitted entries retain normal REPL resumption. Give Sessions truthful Sidekick attribution
without a synthetic entry key or fabricated durable turn.

**Accepted history ownership.** Sidekick has its own durable conversation
history, linked to the retained REPL session and restored with it. It retains
chat and operation feedback. The existing entry Journal remains authoritative
for program source, execution and outcomes; chat does not become synthetic
program entries. Complete exact records, provider association, compatibility
and cross-history effect correlation after the dependent controls are settled.

### 2. Automatic response execution and permission

**Current.** Ordinary generated evaluation admits no REPL control. Evaluating
response text as an ordinary trusted root instead permits a different language,
including executable fences. Evaluate itself renders ordinary fragment output;
it is not a component-result feedback collector.

**Recommendation.** Reuse canonical complete-fragment admission under a dedicated
host-selected Sidekick ceiling. Admit exact REPL control identities/forms,
canonical Elicit and existing pure/structural composition as needed. Do not
broaden entry evaluation or make the agent wrap its reply in Evaluate. Close
the response scope and its resources before any next turn. Verify whether the
existing ComponentAnswerEntry/installation seam carries these exact controls;
return any genuinely missing canonical primitive explicitly.

**Accepted action policy.** Sidekick acts entirely through XMD/REPL controls;
it receives no native shell, file-editing or MCP tools. File/command work is
expressed as an ordinary submitted entry under normal REPL permissions.
Entry permission flags do not widen Sidekick's native tools. The Plan writer
demonstrates a constrained policy but its ownership is Plan-specific, not
a Sidekick implementation to copy wholesale. Specify allowed documentation,
read/write classes, provider permissions and behavior outside the REPL host.
Successful complete terminal response is the only candidate; failed/cancelled
provider output and partial deltas execute nothing.

This ceiling bounds the response controls, not the entry they submit. An
ordinary entry may contain the executable work the entry profile already
permits. Confirm that automatic Sidekick submission carries that ordinary
permission, and settle any intended human review before it starts. A native-tool
denial cannot be presented as a sandbox for an automatically submitted program.

### 3. Input filling, submission and human edits

**Current.** The accepted paired EntryInput operation fills the actual draft;
it does not execute it. The mockup writes `@@Submit entry`, which is not public
XMD. Human input is currently a single shared draft, cleared after admission.

**Accepted submission operation.** `<REPL.Submit />` submits and runs an entry.
It submits the real current shared draft through the root's normal checks,
never a hidden source copy. Filling and submitting remain separate operations.
Do not import the mockup's countdown as a requirement.

Preserve `<REPL.EntryInput>{code}</REPL.EntryInput>` and specify a legal source
representation for tags, braces, quotes, fences and newlines. Define whether
children expand and how their result becomes exact source; raw executable tags
in content cannot accidentally run while filling. Supply a working XMD example
without JavaScript computation. No host-added variable can be assumed to exist
in a generated fragment.

**Accepted manual-edit policy.** Editing the program input takes over the draft
and pauses Sidekick's automatic draft replacements and submissions until the
next explicit instruction or continuation. Chat and binding inspection remain
available; already admitted entries continue under their own owner. Preserve
human text and use root-owned draft revisions to refuse stale writes/submits
and avoid clearing a newer draft when earlier admission finishes. Editing does
not cancel the whole conversation. See architecture-review.md for the source
capture example and the dependent feedback/correlation work.

### 4. Binding selection

**Current.** Entry input inherits acknowledged durable root bindings, while the
visible inspector can read a selected older entry, nested scope or prefix.

**Accepted target.** `<REPL.Bindings />` returns one detached snapshot of the
active execution's acknowledged live root bindings, excluding the reserved
props namespace. Inspecting another entry or History does not retarget it.
The Product Owner suggests a separate syntax for historical reads as a follow-up;
its form and scope are not selected. Include enough provenance to state which
execution frontier answered; no eval environment or provider capability crosses
the response. The accepted read includes an unfinished entry's already retained
root exports immediately, matching the existing projection, without exposing
computed but unrecorded values.

### 5. Feedback payload, correlation and delivery

**Current.** Admission and completion are different operations. Generic
Evaluate renders output and invents no observation collection. The Story
requires operation results, failures, entry outcomes and validated answers to
reach the owning Sidekick independently of chat rendering.

**Recommendation.** Scope a private feedback collector to one complete response
and collect only the host's own REPL operation responses and Elicitation result.
Do not intercept every generic component return. Correlate using the actual
conversation, response, operation occurrence and admitted entry identity,
not prompt content, display names, coroutine IDs alone or current selection.
The Product Owner requests a separate entry-output read API and suggests
instructions rather than an automatic summary. The revised proposal makes
Submit return a completion receipt with entry identity, status and a read
invocation, without a body, preview or summary. Review the proposed
`<REPL.EntryOutput />` member, its paging and bounds. The Product Owner makes
entry optional, with latest output as the default. Negative indexes select
entries: `entry={-1}` is latest and `entry={-2}` is previous. An explicit
`entry="entry-4"` targets that entry in the owning execution. UI selection does
not retarget reads; resolve relative/default selectors once and pin subsequent
pages to the same actual entry identity. The accepted paging defaults to
4096-code-point chunks, accepts a positive limit and an optional signed offset.
Negative offsets count from the end of the selected output (-1 is its last code
point); the omitted offset is -limit, returning the tail. Explicit zero reads
the beginning. Follow-up read instructions carry the selected limit.
Return adjacent read instructions pinned to the actual
entry key and resolved absolute offsets. Signed offsets, the 4096-character
bound and the default tail are accepted. The accepted running-entry
read returns already emitted output as an unfinished snapshot, without waiting,
running or resuming entry execution. The Product Owner now asks about streaming
reads. Clarify whether Sidekick should react during its own submitted entry;
that requires reviewing submission timing and response-level feedback scheduling.
The Product Owner clarifies a two-hour run producing up to 20 MB, asking what
Sidekick does while waiting. The prior wait-flag API/prompt proposal is withdrawn
and was never accepted. The Product Owner accepts blocking Sidekick until its
submitted entry finishes for this version. Show waiting for that actual entry;
the model is idle and Stop Sidekick remains responsive. Completion feedback
returns status, identity and read instructions without an output body or
summary. Background conversation, wait flags and continuous output-following
are not required. Observation changes no component/root buffering.

Return a complete proposed payload with exact fields and examples for bindings,
filled draft, refused submit, admitted entry, completed entry, response failure
and validated answer. Define serialization of values/failures, exact-source
representation, ordering, partial operation success, and when the next Agent
turn begins. The accepted Submit waits for the submitted entry's outcome and
complete teardown before returning completion feedback; observation keeps the UI/root free
to receive input and answer questions. Accepted continuation returns each
response's operation results together, in order, to the same conversation and
requests its next response automatically. Output-only responses wait for the
person and do not trigger a follow-up. The accepted agent-facing result format
uses a single raw successful value, short component
headings for multiple results, and clear failure messages. Correlation IDs and
serialized Result bookkeeping stay internal. Binding feedback is the actual
binding object; EntryInput acknowledges its draft write, REPL.Syntax returns
canonical reference text and Elicit returns the validated answer. Submit's
completion/read-instruction message is accepted in remaining-architecture.md;
the bounded EntryOutput read-message presentation is also accepted. The
4096-code-point size is an initial per-read policy, not a measured optimum or a
provider/Core requirement; it limits neither entry output nor cumulative reads.
The accepted design has a responsive
Stop Sidekick control with no fixed response-count limit. It stops Sidekick's
owned work and further controls while leaving already admitted entries running.
Streaming user-facing Sidekick text during
provider generation and actual operation status are accepted. Resolve preview
parsing, computed content, final-output reconciliation and incomplete/failed
response presentation without executing partial source or silently changing
generic Output. Do not reuse Plan's information-request budget or silently
install a fixed iteration cap.

The accepted streaming presentation labels recognizable literal top-level Output
text Preview until validated response evaluation settles. Computed text waits
for evaluation. Canonical final Output replaces that preview in the same item;
failed/stopped provider responses retain an Incomplete label and execute no
controls. Preview follows canonical syntax and existing publication policy,
confers no capability and reports no speculative operation status. This
observable preview/final-text distinction is accepted; exact parser and host
seams remain architecture work. The agent instruction text in
sidekick-instructions-proposal.md is accepted with initial syntax delivery.
Before each conversation's first provider turn, supply canonical syntax for
both admitted Sidekick responses and actual REPL entries, clearly distinguishing
their availability. Derive it from the installed profiles and component
references, retain the delivered packet, and give every explicit new-agent
conversation its own first-turn reference. Reopening alone starts no turn and
does not resend initial context just because the process is new. Complete
syntax-change recognition with the pending compatibility boundary.

### 6. User output and response failures

**Current.** Top-level Output selects the rendered region; no Output normally
means the whole body renders. Output buffers a declared root's selected output
until completion and preserves ordinary failure/partial-output behavior.

**Accepted presentation.** Preserve ordinary language rules and make Sidekick chat
show only explicit Output regions as a host presentation rule. A response with
no Output can execute controls and return feedback but displays no body text
in chat. The Product Owner accepts this absence rule; it is not a change to
generic Output or Evaluate.
Operation results still reach the feedback channel independently, including
when controls use `as` or render nothing.

Separate a generated-response refusal, an ordinary entry failure, a provider
failure, cancellation and infrastructure/teardown failure. Ordinary validation
errors, operation refusals and entry failures are accepted next-turn feedback
for automatic correction after cleanup. The accepted provider-failure behavior pauses
Sidekick and waits for explicit retry/message in the same conversation; failed
partial source executes no controls. The Product Owner accepts this recovery.
Keep existing fatal-owner contracts for broken infrastructure. Specify earlier successful operation effects
when a later runtime operation fails; whole-source preflight prevents structural
errors from performing earlier controls but is not runtime rollback. Return
exact actionable diagnostics and agent instructions for Product Owner review.

Preserve the existing secret policy across the separate feedback disclosure.
Do not send a value to a following Agent turn before the operation's canonical
validation/publication permits it, or route unscanned diagnostics around the
execution's policy. Specify the trusted disclosure check where one is needed;
secret-policy, scanner and journal failures stop the owner rather than becoming
ordinary retry feedback.

### 7. Questions and stopping

**Current.** Entry Elicit uses a schema-backed drawer. Arrival announces without
navigation, invalid input keeps the wait, closing answers nothing, and scope
teardown removes it. A provider instance holds only one pending question.

**Recommendation.** Reuse the same bounded schema language and validation in a
distinct Sidekick-owned provider instance; route requests/answers by owner.
The accepted question drawer is inside Sidekick chat and opens on explicit
activation. Arrival switches no tab or focus. Tab changes retain the pending
question and form values while unmounting hidden UI targets. Accepted explicit
drawer close also preserves the partially entered answer; this differs
from the current entry drawer. Complete simultaneous
entry/Sidekick question routing and History behavior under independent owners.

The accepted Stop Sidekick control halts/joins the
current Agent turn or response, revokes unfinished control requests, preserves
the shared draft, and leaves an already admitted entry running under its own owner.
A withdrawn question fabricates no answer. No fixed iteration cap applies.
A later Send continues the same retained conversation under existing identity
checks and does not replay cancelled controls. Complete the retained feedback
for already performed effects and a stopped result wait.
Command exit cancels and joins all owners and restores the terminal once;
it cannot append an invented cancellation or answer.

### 8. Agent option and fallback

**Current.** Agent stack resolves DEFAULT_AGENT_NAME and the package default
lazily for ordinary entries; the grammar explicitly enumerates allowed flags.

**Accepted selection.** Preserve the requested `--sidekick-agent <name>` exactly.
Resolve its independent fallback to DEFAULT_AGENT_NAME/package default, without
letting explicit `--default-agent` override Sidekick. Use the selected provider
already assembled for the command. General settings/provider management stay
deferred, but the Product Owner now requires Sidekick-specific agent/model/thinking
selection before accepting unavailable-agent behavior. Specify
missing/empty value, unknown agent timing and help wording. The accepted behavior
checks availability when explicit Sidekick work needs it, reports an unavailable
Sidekick in its own area and leaves ordinary REPL work usable. This availability
behavior includes Retry and Configure through the accepted selector; retain
existing shared-provider/CLI/fatal contracts and never substitute a conversation
after an identity mismatch.
The accepted configuration surface is Configure in the Sidekick header opening
a drawer inside its pane. Reuse Agent.options and Core's verified model/effort configuration;
refresh effort after model selection and represent unsupported choices honestly.
Review selector placement, agent identity changes, model, effort, application
timing/retention and recovery before freezing this expanded boundary. The accepted
agent change explicitly starts a new provider conversation, retaining
prior chat and its truthful association, while the same REPL-owned Sidekick
restores the active conversation on reopen. Model/effort changes reuse verified
in-place configuration. The accepted timing stores preferences with the
conversation and applies them to its next provider turn, without interrupting
current work. Requested preferences and verified applied settings remain
distinct; rejected configuration starts no turn under a substitute. Busy agent
switching is accepted as Stop and start new conversation: join stopped Sidekick
work before switching, keep an admitted entry running, retain prior chat and
association, and wait for an explicit message before sending a model prompt.
Unavailable-agent recovery is accepted: offer Retry for the retained
conversation and Configure for explicit selection changes; failed new-agent
initialization preserves the previous active association. Ordinary REPL work
remains available under the existing CLI, storage and policy failure contracts.

### 9. Narrow composition and visual adaptation

**Current.** At 72×20 there is one routed outlet and no right inspection column.
The footer has seven rows; the entry draft occupies its last row. The export
is a 2560×1440 browser scene and cannot decide terminal capacity.

**Accepted.** Add Sidekick beside Sessions and Entries in the narrow surface
controls. Selecting it uses the content area for chat, status, Stop, Configure,
its separate chat input and its drawers, while retaining the shared program
draft and existing History/exit reachability. Every other outlet/tab content is absent
from drawing, focus and pointer maps. Opening Sidekick is an explicit action;
background activity never routes there. Confirm route/location spelling,
default tab, focus restoration, visible pending-work cues, measured chat window
and resize recovery. Settle footer/editor changes expressly; do not infer them
from the mockup. The accepted new-session default selects Sidekick in the
wide/medium right pane while preserving the ordinary entry draft's initial
focus and the narrow Entries default. Reopening restores saved presentation
selection. The accepted resize mapping keeps the selected reading: explicit
Sidekick activation maps to the narrow Sidekick outlet and back to the wide
right pane; Entries and Sessions retain their own narrow outlets. The default
visible Sidekick tab alone does not change the selected reading. Drafts, chat,
pending questions and work survive. Explicitly activating Sidekick with no
drawer open is accepted to focus Message Sidekick; Send keeps that focus and
agent draft fills never move it. The existing program field remains Draft.
Initial tab display preserves the entry draft's initial focus; open drawers
retain mounted modal ownership and restoration. The accepted busy composer
remains editable with Send disabled, status and Stop visible. Completion or
Stop enables explicit Send rather than automatically sending prepared text.
Send admission preserves newer draft revisions; refusal preserves the draft.
Busy-composer acceptance selects no durable unsent-chat-draft storage.

The original local export shows thin #161c21 edges and header separators.
The architecture review pins the accepted stronger column/header refinement and
two reviewed browser captures in reference/README.md. Return the terminal
adaptation mapping and independent expected relationships before visual
acceptance is frozen. Browser references do not establish production parity.

## Required return and continuity

Return the accepted member-by-member control/feedback interface, ownership and
lifetime, permission ceiling, persistence/compatibility policy, failures,
cancellation/teardown, route/narrow composition, internal agent instructions,
and approved product verification. Identify decisions explicitly deferred and
whether they block this Story. Confirm coherent PR boundaries after #881.

The Planner then refreshes the base, traces those exact contracts, freezes a
finite evidence matrix and focused commands, and writes a self-contained
Implementor handoff. Do not ask the Implementor to settle a remaining product
choice. This handoff creates no approval or exception to the repository rules.

Exact research base: `20462295c2ac44305577359583be0a33004cc428`.
Artifacts: `.reviewer/issue-883/{README,implementation-plan,architect-handoff,
acceptance-proposal,architecture-review,sidekick-instructions-proposal}.md` and
`reference/`. Settled: Story #883's requirements and the Product Owner decisions
in the architecture review, including control behavior, configuration,
presentation and first-turn syntax. Remaining readiness gaps: exact generated
response/feedback and persistence/recovery/compatibility contracts, plus approved
product verification and terminal adaptations. Full #881 parity is the recorded
implementation predecessor. Next Architect action: complete these contracts and
verification; next Planner action afterward: refresh the base and freeze the
plan. Next Implementor action: wait for that frozen handoff.
