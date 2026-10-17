# Architecture review for #883

**Product Owner spelling correction, 2026-10-15:** use `--sidekick-agent` and
`sidekickAgent` throughout active implementation and instructions. This supersedes
the earlier exact-spelling instruction. Selection, ownership and persistence
contracts are unchanged. See
[the current correction](pr2-terminal-completion-implementor-correction-d634b28b.md).

This file retains the original interview evidence. The completed handoff is
[planner-handoff.md](planner-handoff.md); the subsequent accepted
[syntax discovery amendment](syntax-discovery-amendment.md) supersedes the
full-initial-reference decision below with progressive disclosure and extends
the designated read components.

The planning packet supplies research and recommendations. It does not settle
the open product decisions or freeze implementation acceptance. The Architect
reviews those decisions with the Product Owner before the Planner finalizes the
implementation handoff. Completion of #881 remains a separate implementation
prerequisite.

## Boundary review

The feature combines a dedicated conversation owner, REPL controls and feedback
outside ordinary entry execution. Its ownership, lifetime and persistence
therefore require the system-boundary interview in .agents/architect.md.
The review follows the handoff's nine areas, one at a time:

1. Conversation lifetime, retention and historical inspection.
2. Automatic response execution and permission.
3. Shared input filling, submission and human edits.
4. Binding selection.
5. Feedback payload, correlation and delivery.
6. User output and response failures.
7. Questions and stopping.
8. Agent option and fallback.
9. Narrow composition and visual adaptation.

The REPL root's state/admission ownership, immutable submitted source,
sequential entries, tab-independent execution and mounted-tree focus already
follow the accepted Story and existing rulebooks. These are constraints for
the review, not new decisions awaiting approval.

## Item 1 of 9: conversation lifetime

Status: conversation ownership, retention, historical inspection, explicit
continuation after reopening and separate retained Sidekick history accepted.
Exact storage records and compatibility are completed after the dependent
control/feedback contracts are reviewed; implementation remains blocked.

The Product Owner settles retention: each REPL session has its own Sidekick,
and reopening the same REPL session reopens the same Sidekick.

- Sidekick identity belongs to the retained REPL execution, rather than an
  entry, tab or command invocation.
- Each new REPL session has its own Sidekick conversation.
- Entry submissions and tab changes preserve that identity.
- Reopening a retained REPL session restores its existing Sidekick
  conversation, rather than creating a fresh conversation from copied chat.
- Exiting ends the process's owned work and resources without discarding the
  session's Sidekick association.

An explicit agent change starts a new provider conversation within this same
REPL-owned Sidekick, as accepted in item 8. Prior chat and its original provider
association remain retained. Reopening restores the active conversation; ordinary
entry submissions, tab changes and process reopening do not replace it.

The current entry Journal accepts consecutive entry ranges, each beginning at
the root import and ending at its root Close. An Agent turn recorded between
entries is refused by partitionEntrySegments in packages/cli/src/repl/entries.ts.
The corresponding malformed-history regression is in repl-entries.test.ts.
The existing Agent observer attaches turns to entry ownership and does not
observe direct Agent.prompt calls as retained Prompt work. A durable Sidekick
conversation therefore requires an expressly accepted source of truth and
reconstruction contract.

The accepted decision supersedes the proposed invocation-only conversation.
The Sidekick history is the source of truth for its retained conversation and
feedback, linked to the retained REPL execution. The exact persisted identity
association, provider resumption, record representation and interruption
reconciliation remain architecture work. Storage preserves the accepted
per-session identity and existing entry reconstruction guarantees.

### Accepted historical inspection

The current REPL freezes the execution projection at the selected History
position while keeping the shared next-entry draft editable. Submission is
refused until the person returns to the live head.

The accepted Sidekick behavior keeps its conversation current while the person
inspects earlier execution. History changes the execution view without
rewinding or replacing the Sidekick conversation. The person can discuss work
and prepare the draft; ordinary admission still refuses submission from
historical inspection. Binding-selection semantics are reviewed separately
in item 4 and are not settled by this proposal.

The Product Owner accepts this behavior in conversation. Historical inspection
does not rewind or replace the Sidekick, start a different conversation, or
change the ordinary submission guard.

### Accepted reopening behavior

Restoring the same Sidekick conversation does not by itself decide whether
reopening starts another Agent turn or resumes an unfinished response program.
The current cold-inspection contract performs no provider call. An unfinished
ordinary entry has its own existing resumption behavior.

The accepted behavior restores the Sidekick conversation and known work state, then
waits for an explicit message or resume action before continuing Sidekick work.
Any already admitted entry follows ordinary REPL resumption. Reopening alone
starts no additional Sidekick turn or control execution.

The Product Owner accepts this behavior after clarification that exit means
ending the whole REPL process, not closing a drawer. The exact continuation
control belongs to the questions/stopping review; reopening alone continues no
Sidekick work.

Existing Agent session identity and reattachment rules are relevant to the
durable design: the same conversation is reattached rather than rebuilt by
replaying chat into a new conversation. Failure to validate that retained
identity refuses rather than silently creating a substitute. The existing
Session placement/mapping boundary and REPL storage differ; the exact host
integration and persisted association remain architecture work.

### Accepted retained-history ownership

The accepted design gives the Sidekick its own durable conversation history, associated
with the retained REPL session. It holds chat turns, the established provider
conversation association and the operation feedback needed to continue that
conversation. The existing entry Journal remains the source of truth for
program source, execution and entry outcomes. Sidekick history refers to actual
admitted entries rather than creating synthetic entries for chat.

Reopening restores the saved conversation view without running response XMD or
sending a provider turn. Explicit continuation reattaches the same provider
conversation under the established identity/resumption checks. Execution
History navigates program entries; it does not rewind Sidekick chat.

The Product Owner accepts this division in conversation. It changes the current
one-file REPL reconstruction boundary. A compatibility contract, exact record
shapes and admission/completion correlation follow the control and feedback
members reviewed next. No file layout or generic persistence framework is
selected by this decision.

## Item 2 of 9: automatic response execution and permission

Status: XMD-only actions and no native Agent tools accepted. Exact admitted
control forms follow the member reviews below. The generated response-root
context remains a required engine-boundary resolution.

The accepted feature evaluates complete Sidekick responses as XMD, using
REPL controls to inspect bindings, fill the draft and submit entries. The
Product Owner accepts that these are the Sidekick's action path: it receives
no separate native shell, file-editing or MCP tools.

The current REPL profile supplies ordinary entry execution and a separate
generated-fragment ceiling. Canonical Evaluate admits complete source against
the host-selected profile; it grants no REPL control merely because an Agent
returned its spelling. The Plan writer supplies a closest existing example of
an Agent with empty native-tool and MCP lists plus provider-owned strict denial.
Its Plan-specific ownership and persistence are not Sidekick contracts.

The accepted policy gives Sidekick no native tools. It performs actions through the
REPL's admitted XMD controls. Work such as reading project files or executing
commands is expressed as an ordinary REPL entry, executed under that entry's
normal capability and permission rules. This policy constrains the Sidekick's
direct actions; it is not a sandbox for the programs it submits.

For example, Sidekick inspects bindings through REPL.Bindings, writes source
through REPL.EntryInput and submits through the separately reviewed control.
It does not use an Agent shell or file editor for those actions.

Canonical complete-source admission is the existing boundary for generated
response evaluation. The exact Sidekick ceiling follows the accepted control
forms and contextual Elicit, with existing pure/structural composition as
needed. Streaming deltas and failed/cancelled provider output are not executed.
Entry execution permissions remain a separate boundary reviewed alongside
automatic submission.

The native-tool restriction applies independently of the command's permission
flags. Those flags retain their ordinary meaning for entry execution; they do
not widen Sidekick's direct Agent tools. Internal instructions and the retained
provider policy express this same boundary.

The existing generated-fragment path is not sufficient for the accepted
response contract: generated-xmd.ts rejects Output, Content and Return through
NO_GENERATED_CONTEXT, and executable-mdx-spec.md explains that a fragment has
no independent output region. A Sidekick response requires a canonical
generated root with ordinary top-level Output semantics. Resolve that exact
engine/host seam before implementation rather than passing provider source to
trusted-root execution or changing generic Evaluate/Output behavior silently.

## Item 3 of 9: shared input, submission and human edits

Status: REPL.Submit and manual-edit takeover accepted. Literal-source examples
reuse existing capture/interpolation semantics; bindings are reviewed next.

The accepted REPL.EntryInput operation fills the real shared draft without
executing it. The current UI's Run action submits that draft through root
admission and records an ordinary immutable entry. A generated Sidekick response
needs an explicit operation for the same behavior; the mockup's @@Submit entry
is a demonstration marker rather than valid XMD.

The Product Owner accepts the self-closing operation:

```md
<REPL.Submit />
```

It submits and runs an entry from the real shared input through the root's
normal admission checks. It supplies no hidden program source. EntryInput
alone still runs nothing. It creates no queue, bypasses no running-entry or
teardown guard, and cannot submit from historical inspection. The admitted
entry runs under normal REPL permissions, consistent with item 2's accepted
action path.

The accepted manual-edit policy and source representation are recorded below.
Exact operation feedback and effect correlation follow in item 5. The mockup's
countdown and cancellation of the whole Sidekick on edit are not requirements.

### Accepted manual-edit behavior

The current UI snapshots the shared draft into its submission intent and clears
the draft after admission. Adding an independent Sidekick writer makes it
necessary to correlate writes and admission with the draft they address.

The accepted behavior treats a manual change to the program entry input as taking over
that draft. If the person edits it while Sidekick is working, Sidekick's pending
or later automatic draft replacements and submissions are paused. The person's
text remains. Sidekick may continue conversation and inspect bindings; an
already admitted entry remains under its own execution owner.

The next explicit message or continuation gives Sidekick the current draft to
work with again. Edits after that activation pause writes/submissions again.
This provides one visible takeover rule instead of an extra overwrite-confirmation
flow. Pending requests use root-owned draft revisions so a response based on
the earlier draft cannot overwrite or submit the newer one. An admission
acknowledgement cannot clear draft text that belongs to a newer revision.

The exact source representation and operation feedback remain separate reviews.
The accepted behavior does not cancel an entry that has already been admitted or turn
editing into a Stop Sidekick action for the whole conversation.

The Product Owner accepts this takeover behavior in conversation.

### Literal source through existing XMD

EntryInput receives rendered text and places that text in the shared draft; it
does not parse that result as a second program. Existing Let capture provides a
literal source representation without adding a new raw-content language form:

````md
<Let as="code" select="code">
```xmd
<Each in={names} let="name">
Hello, {name}!
</Each>
```
</Let>
<REPL.EntryInput>{code}</REPL.EntryInput>
````

The fenced program is passive text. Let selects the code node's value, removing
the enclosing Markdown fence, and the body reference places that string into
EntryInput. Tags, quotes and braces in the captured value are not evaluated as
Sidekick instructions. A longer enclosing fence handles source containing
shorter fences. Submission remains a separate REPL.Submit operation.

This representation follows existing Let/select, fenced-text and binding
interpolation contracts and introduces no JavaScript computation. A direct Let
value holding a quoted string is also ordinary declarative data when exact
string boundaries are required. Do not copy the mockup's template-literal
expression: generated data expressions refuse template literals, and body
interpolation is not arbitrary JavaScript evaluation.

No end-to-end EntryInput implementation exists at this research base. Its
focused evidence must check captured source, actual draft and admitted source,
including braces, nested fences, quotes and newlines. This example establishes
the authoring pattern, not a claim that the Sidekick feature already executes.

## Item 4 of 9: binding selection

Status: current-root binding target and running-entry read boundary accepted.

The current visible inspector can show a selected entry, nested scope or
historical prefix. The next ordinary entry inherits acknowledged durable root
bindings. Those are different views of the execution.

The accepted decision has REPL.Bindings read the active REPL's current retained root
bindings rather than whichever historical or nested scope the person happens
to be inspecting. Selecting another entry, History position or tab changes no
operation target. The result is a detached value snapshot, with provenance
reviewed alongside feedback. It exposes no live evaluation environment and
excludes the reserved props namespace.

For example, if names is ["Ada"] in Entry 1 and ["Grace"] at the live head,
inspecting Entry 1 leaves the Sidekick's active binding read at ["Grace"]. The
visible Bindings inspector can still show ["Ada"] for the historical selection.
The UI and feedback distinguish those contexts.

The Product Owner accepts this target and suggests a different syntax for
historical reads. That is a follow-up interface; no historical-read syntax or
additional acceptance requirement is selected here.

The existing projection includes acknowledged root exports before an entry
finishes. The accepted read includes those retained values immediately. For
example, an entry publishes count = 3 and continues running; REPL.Bindings
returns 3 without waiting for completion. Computed values not yet durably
published are absent. Each read returns one detached snapshot, not a live watch.
The Product Owner accepts this running-entry boundary in conversation.

## Item 5 of 9: feedback payload, correlation and delivery

Status: submission completion timing and automatic continuation accepted.
Streamed Sidekick text and operation status are accepted as product behavior.
Stopping without a fixed iteration cap is accepted. EntryOutput's default tail,
4096-character bound, signed offsets and unfinished snapshots are accepted.
Exact feedback records and the streaming presentation seam remain architecture
work across the remaining reviews.

The existing session submit operation acknowledges admission, while join waits
for the admitted entry's result and resource teardown. These are different
boundaries. Sidekick needs the actual result to revise its program rather than
treating an admission acknowledgement as successful execution.

The accepted `<REPL.Submit />` admits the current shared draft, then waits for
that exact entry to finish and its resources to be released. It returns the
entry outcome through Sidekick feedback. An admission refusal returns promptly
without waiting for an unrelated running entry or creating a queue. The wait
belongs to Sidekick's response scope; the root remains responsive so the person
can use the REPL and answer the entry's questions.

For example, Sidekick submits a greetings program. The person sees the ordinary
entry run. After it finishes, Sidekick receives its outcome rather than merely
"started". Cancelling this feedback wait does not transfer ownership of an
already admitted entry to Sidekick. Exact result fields, retention, correlation,
and when results trigger another provider turn follow this timing decision.
The Product Owner accepts completion timing in conversation.

### Accepted automatic continuation

After one complete response program finishes and releases its resources, the
host returns its collected operation results to the same Sidekick conversation
and requests the next response automatically. Results from one response are
delivered together in operation order; they do not start overlapping provider
turns. Rendering user-facing Output alone supplies no operation feedback and
starts no automatic follow-up.

For example, Sidekick reads bindings, receives their snapshot, then fills and
submits a greetings program. It receives that entry's completed result and can
explain it or revise the draft. When a response only explains the result,
Sidekick waits for the person. Iteration limits and ordinary failure feedback
are reviewed separately; this decision selects no unlimited retry policy.
The Product Owner accepts this continuation behavior in conversation.

### Accepted streaming experience

The current engine buffers a root declaring Output until its expansion finishes.
Using that behavior for Sidekick would delay selected chat text until the
response program finishes, including any Submit completion wait. Provider text
can arrive incrementally, but complete-source admission still precedes control
execution. The REPL consumes ordinary execution output as the engine emits it;
an entry's own Output retains its existing buffering semantics.

The Product Owner accepts streaming user-facing Sidekick text during provider
generation, alongside actual operation status such as Reading bindings or
Running Entry 4. Complete-source validation still precedes control execution.
This requires an explicit host presentation contract, distinct from executing
incomplete response source or silently changing generic Output. The exact
preview parser, computed-content handling, final-output reconciliation and
failed/cancelled response presentation remain architecture work. This accepts
the experience rather than an unreviewed language change.

### Accepted streaming preview and final text

While the provider response arrives, show recognizable literal text from its
top-level Output regions as Preview. This is a presentation of candidate source,
not execution or a promise that a described action happened. Ordinary status
continues to report only actual provider/REPL work. Computed content, binding
interpolation and component-produced text wait for validated evaluation.

After the complete response is admitted and its program finishes, canonical
evaluated Output replaces the preview in the same response item; do not append
a duplicate final message. If provider generation fails or is stopped, retain
any shown preview with an Incomplete label and execute no controls. Evaluation
failure retains truthful partial rendered output and its failure status rather
than marking the preview complete. The accepted distinction is Preview during
generation and response execution, final evaluated text on settlement, and
Incomplete for an unsuccessful provider response.

Incremental recognition must follow canonical syntax, including fences and
Output placement, rather than a tag regular expression. Preview admits no
capability and obeys existing disclosure/publication policy before presentation.
Ambiguous or computed portions remain pending rather than guessed. The exact
parser/presentation seam and reconciliation mechanism remain architecture work.
The Product Owner accepts this observable preview/final-text distinction in
conversation.

### Accepted stopping contract

The Product Owner questions the need for a fixed iteration limit when there
is a way to stop Sidekick. The Architect withdraws the ten-follow-up proposal
and the accepted design has no fixed response-count limit for this version. A text-only
response ends automatic continuation under the accepted rule.

Provide a visible Stop Sidekick control reachable while generating, evaluating,
waiting for a question or waiting for entry completion. Activating it revokes
further control admission and automatic continuation, cancels and joins the
owned provider/response work, and preserves the conversation and shared draft.
No stopped question fabricates an answer. Control requests already in flight
must pass the root's current ownership/revision check rather than execute after
Stop from a stale response.

The accepted boundary leaves an already admitted ordinary entry running under
its own owner. Existing Exit ends the whole REPL and joins all owners, including
entry execution. There is no existing general Cancel Entry control to promise
as the Sidekick escape hatch. The Product Owner accepts Stop Sidekick leaving
admitted entries running in conversation. Exact placement and stopped-response
retention follow the remaining interface reviews.

### Proposed completed-entry feedback

The Product Owner calls for an API to read an entry's output and suggests that
Submit can return instructions for reading it rather than an output summary.
The Architect replaces the preview proposal with a completion receipt: exact
admitted-entry identity, completion status and an invocation for reading that
entry's output. No output body, preview or generated summary is attached by
default. Failure/refusal diagnostics and their bounds remain in the exact
feedback-record review.

Binding values remain available through REPL.Bindings rather than automatically
attaching a root snapshot to every completion. Feedback describes the actual
outcome after teardown; a stopped Sidekick wait cannot manufacture a cancelled
terminal for the entry. Retention, serialization and disclosure checks follow
the actual host result; no live evaluation environment or unsanitized error
stack is returned.

### Entry-output read under review

The Product Owner specifies that entry is optional and the bare operation reads
the latest output. The working interpretation is the latest entry's output,
independently of the selected entry or History position:

```md
<REPL.EntryOutput />
<REPL.EntryOutput entry="entry-4" />
```

The Product Owner accepts negative indexes as selecting earlier entries:
`entry={-1}` selects the latest entry and `entry={-2}` the previous entry.
They select entries rather than positions within output. Positive indexes and
zero are not selected by this decision.

The entry is identified within the owning retained REPL execution. Selection,
History inspection and tab changes do not retarget this read. Default/relative
selectors resolve to an actual entry identity when the root accepts the read;
subsequent pages refer to that same entry rather than resolving latest again.
The proposal
returns a bounded text chunk and a way to request the next chunk, with an
explicit end indication. It does not summarize the output. Paging form, exact
bounds and availability for unfinished entries
remain under review. This is a new member of the Sidekick control boundary; include it
in the eventual complete interface and generated capability ceiling.

### Accepted output paging

The read defaults to 4096 Unicode code points and accepts a positive limit prop
for a different chunk size, as accepted in the later feedback review. Offsets
use those same units, so a page never splits a code point.
Return the actual entry identity, the text chunk, whether the output ends here,
and ready-to-use read invocations for adjacent chunks when more remains. Those invocations
use the actual entry identity, not the original relative/default selector:

```md
<REPL.EntryOutput entry="entry-4" offset={4096} />
```

Sidekick can follow the provided invocation without computing offsets. A new
entry admitted between pages cannot shift that target. The Product Owner adds
negative offsets, interpreted as positions counted from the end of the selected
entry's output: -1 starts at its last code point and -4096 starts 4096 code points
from its end. A negative position before the beginning clamps to zero. The
accepted default starts at offset -4096, returning the tail; explicit
offset zero reads from the beginning. Resolve the requested position once
against the observed output and report that absolute position; subsequent read
instructions use the actual entry key and absolute offsets. The read is bounded independently of output size and
summarizes nothing. Exact feedback fields and empty/out-of-range behavior follow
the accepted paging model. The Product Owner accepts the default tail and
4096-character bound in conversation. Exact feedback fields and read-boundary
diagnostics are completed in the final interface/architecture record.

### Accepted running-entry read

The later feedback review accepts a per-read limit prop after the Product Owner
questions the fixed 4096 maximum. That amendment is in remaining-architecture.md.
Bare EntryOutput still means the latest 4096-character tail; an explicit limit
changes the chunk size and, without offset, reads that many characters from the
end. Follow-up read instructions preserve the chosen limit.

When the selected entry is still running, return a snapshot of output already
available from ordinary execution, clearly marked as unfinished. Return no
content the engine has not emitted, and do not wait for the run to finish. A
negative offset resolves against that snapshot's current length. Follow-up reads
can observe later output; they do not make the earlier snapshot complete or
change its reported range. A root's ordinary Output buffering remains in effect.
Reading must not execute or resume the entry. Publication, durable feedback and
reopening must distinguish observed output from an entry's terminal outcome.
The Product Owner accepts this snapshot behavior in conversation, then asks
whether a streaming-output read is also needed.

### Streaming entry-output question

Distinguish the existing UI's display of engine-emitted output from Sidekick
receiving output incrementally and taking another provider turn before the
entry finishes. The current accepted Submit waits for completion, and response
feedback starts another turn only after the response program finishes and
releases its resources. Those rules do not yet let Sidekick react during its own
submitted entry's execution.

Clarify whether that reaction is the desired streaming behavior. A suitable
agent-facing design can deliver bounded newly available chunks, rather than
unbounded text or polling responses with no new output. It must retain one
provider turn at a time, responsive Stop, truthful completion/teardown and
entry ownership independent of Sidekick. Exact read/wait syntax, submission
timing changes and feedback scheduling remain unaccepted. Do not silently
replace the accepted Submit timing or add concurrent provider turns.

### Long-running entry and Sidekick availability

The Product Owner clarifies the question with an entry running for two hours and
producing up to 20 MB of output. The concern is what waiting looks like and what
Sidekick does during that time, rather than selecting a chunk-following API.
The proposed wait forms and their internal instructions are withdrawn from the
active interface review; neither was accepted.

The provider response that starts the entry is already complete before its XMD
controls execute. A host operation waiting for entry completion does not itself
keep the model generating or request another provider turn. The entry's owner
collects its output and the UI shows its actual running state and available
output. Large output remains with the entry; completion feedback does not
automatically send its body to the model. Explicit EntryOutput reads let
Sidekick inspect bounded portions, including the tail, when useful. Typical
short summaries require no continuous output-reading loop.

The Product Owner accepts keeping Sidekick blocked until the submitted entry
finishes for this version, because it is the expected default in most cases.
Submit keeps that response program unfinished; another Sidekick turn starts
only after it finishes or is cancelled. The UI distinguishes this state as
waiting for the actual entry, rather than active model generation. Stop Sidekick
remains responsive and ends the wait without stopping the admitted entry.
The ordinary REPL remains usable, including entry-owned questions.

Completion feedback contains entry status, identity and read instructions, not
the output body or a summary. Sidekick inspects output explicitly if needed.
There is no background-conversation or continuous agent-output-following
requirement for this version. Completion remains correlated to the submitted
entry and follows its teardown. Do not add wait flags, notification subscriptions
or overlapping provider turns to solve the two-hour example.

The accepted default makes bare EntryOutput read the latest entry's last 4096 code
points. A shorter output is returned whole; a longer output has explicit range
and additional-read instructions. Explicit offset zero reads the beginning.
The Product Owner accepts this default-tail behavior in conversation.

## Item 6 of 9: user output and response failures

Status: explicit Output-only chat presentation and ordinary-error continuation
accepted. Provider-failure recovery is accepted; the streaming presentation seam
remains architecture work.

Ordinary XMD renders a root's body when it declares no Output. Sidekick's
accepted separation uses Output for person-facing chat and a distinct channel
for operation feedback. The accepted Sidekick presentation rule shows only
explicit Output regions in chat. A controls-only response may have no Output:
it still executes and returns operation feedback, while the UI reports actual
work status. Unwrapped prose and operation values are not implicitly chat.

This is an explicit Sidekick host presentation rule, not a change to ordinary
XMD rendering or Evaluate. Complete-source admission and the generated-root
Output boundary still require the engine resolution recorded in item 2.
The Product Owner accepts this no-Output presentation rule in conversation.

### Accepted ordinary-error feedback

Return generated-source validation errors, ordinary REPL operation refusals and
entry failures as feedback to the owning Sidekick, then permit the next response
under the accepted automatic-continuation rule. The person sees the actual
failure/refusal status. A structurally invalid response performs no controls;
Sidekick receives the validation diagnostic and can author a corrected response.
If a later runtime operation fails after earlier controls succeeded, report the
actual prior results and failure without rolling back or repeating those effects.

An entry failure remains an immutable failed entry; a revision is a new ordinary
entry under the usual readiness guards. Error feedback grants no new permission
or release from manual draft takeover. Completion still returns metadata and
read instructions rather than the output body. The ordinary-error decision does
not select automatic retry for provider, journal, scanner, policy or teardown
failures. Those failures are reviewed separately or follow existing fatal-owner
contracts. The Product Owner accepts automatic correction for ordinary errors
in conversation.

### Accepted provider-failure recovery

When a provider turn ends unsuccessfully, pause Sidekick and show an actionable
failure message. Keep the conversation and shared draft. Any streamed text is
identified as incomplete/failed rather than treated as an admitted response.
No controls from that failed or cancelled provider response execute.

The person explicitly retries or sends another message to continue the same
conversation under existing identity checks. Do not invent a replacement
conversation or automatically start successive failed provider turns. Already
admitted entries retain their own execution owner. Adapter-level recovery within
a still-running provider operation retains its existing meaning; this proposal
concerns a provider turn that actually ends in failure. Exact retry control and
message wording follow the interface review. The Product Owner accepts this
provider-failure recovery in conversation.

## Item 7 of 9: questions and stopping

Status: Stop Sidekick ownership and a question drawer inside Sidekick chat are
accepted. Drawer-close draft retention is accepted; exact simultaneous-request
presentation remains architecture work.

Existing entry Elicit requests appear as a waiting-question announcement. Explicit
activation opens a schema-backed drawer; arrival changes no focus or route.
Invalid submission stays open with field diagnostics. Closing answers nothing
and leaves the request waiting. The existing entry drawer discards its form
draft on close, and activation selects its owning live entry.

The accepted Sidekick question uses a drawer within the Sidekick chat area.
Reuse the same form language and canonical validation through a separate
Sidekick-owned provider instance.
Show a Sidekick question-waiting announcement and open its drawer only when the
person activates it. Do not use the entry provider's single pending slot.
Attribute requests and answers to their actual owner, never the selected entry.
Tab changes preserve the pending request and form values under the already
accepted tab-preservation contract. A hidden Sidekick tab contributes no drawer
nodes or input targets; its question lifetime remains owned independently.
Exact simultaneous-question presentation and focus restoration follow the
approved mounted-tree rules. The Product Owner accepts drawer placement inside
Sidekick chat in conversation.

### Accepted drawer-close behavior

Closing the Sidekick drawer hides its presentation while leaving the question
waiting and retaining its partially entered answer. Opening it again restores
those fields. This differs from the current entry drawer, which discards its
form draft on close. A valid answer resolves only the Sidekick-owned request;
Stop Sidekick withdraws it without manufacturing an answer. This draft-retention
decision concerns presentation during the current process and selects no new
durable form-draft storage. The Product Owner accepts it in conversation.

Question ownership follows the accepted boundary: entry and Sidekick requests
use distinct provider instances and answer only their own pending request.
An entry's announcement retains its existing activation-to-live-entry behavior.
Opening the Sidekick drawer does not retarget the main entry or History view;
Sidekick remains live under item 1. Arrival steals no focus. Mounted-tree focus
and explicit owner routing govern drawer activation and return. After Stop,
the next explicit message continues the same retained Sidekick conversation
under existing identity checks; it does not replay a cancelled response's
controls or manufacture an answer. Completed effects remain facts in feedback.

## Item 8 of 9: agent option and fallback

Status: independent --sidekick-agent spelling and omitted-value fallback are
accepted. The Product Owner requires agent/model/thinking selection before
accepting Sidekick-unavailable behavior. A Sidekick-only configuration drawer is
accepted. Agent-change identity and model/effort timing and retention are
accepted, including stopping Sidekick work before an explicit busy agent switch.
Unavailable-agent recovery is accepted. Narrow composition is reviewed next.

The existing CLI chooses an ACP agent name, such as codex or claude. Ordinary
entry Agents resolve explicit --default-agent, then DEFAULT_AGENT_NAME, then the
package default (currently codex). The command already selects its provider;
the current registered provider is acpx. General settings/provider management
remain deferred. Sidekick-specific agent/model/thinking selection is now a
required interface review rather than part of that blanket deferral.

The accepted new-session Sidekick selection resolves explicit --sidekick-agent,
then DEFAULT_AGENT_NAME, then the package default. Explicit --default-agent
never changes that selection. Both defaults may share the environment/package
fallback without sharing the entry flag. For example, --default-agent claude
and --sidekick-agent codex select Claude for unnamed entry Agents and Codex for
Sidekick. Without the Sidekick flag, an entry override alone does not change
Sidekick's fallback.

Reopening retains the existing Sidekick conversation and its recorded selection
under item 1; fallback is not permission to silently replace that identity.
Exact mismatch diagnostics, lazy availability checks and configuration-failure
presentation follow this default decision. The Product Owner accepts the fallback
order in conversation.

### Accepted Sidekick-unavailable behavior

Resolve command syntax and the shared provider under their existing CLI rules.
Do not contact the Sidekick provider merely to reopen or inspect a conversation;
check actual availability when an explicit message or continuation needs it.
If that Sidekick agent is unavailable or its agent-specific configuration cannot
be used, show the reason in Sidekick and leave ordinary REPL work available.
Keep the conversation association and draft; retry only after explicit action,
and never silently substitute an agent or create a fresh provider conversation.

With the accepted configuration drawer available, the accepted recovery offers
Retry for the same conversation or Configure to change the selection. Model and
effort corrections apply through the accepted next-turn contract; changing
agents explicitly starts a new conversation and retains the prior chat. A failed
new-agent initialization does not replace the previous active association.

This proposal does not excuse malformed CLI syntax, an unknown shared provider
or failures that existing trusted storage/policy contracts make fatal. Retained
identity mismatches still refuse Sidekick use instead of pretending a different
agent is the same conversation. Exact initialization/mismatch diagnostics follow
the final architecture record. The Product Owner accepts this recovery after
reviewing the required agent/model/thinking selection surface. Retry continues
the same retained conversation; choosing another agent explicitly starts a new
conversation and retains the old chat. Ordinary REPL work remains usable.

### Accepted Sidekick-only configuration surface

Provide a configuration control in the Sidekick header that opens a drawer in
the Sidekick area. Its three choices are Agent, Model and Thinking effort.
This is a focused Sidekick surface rather than a general settings screen.
Use provider-advertised model and effort ids, names and grouping through the
existing Agent.options contract. Refresh effort choices when the model changes;
an unsupported setting says unavailable rather than inventing a choice.

The existing Core configuration contract validates and applies model first,
refreshes effort, applies effort and verifies exact readback. It supports
reconfiguring the same established provider conversation only when the provider
can preserve that identity. Option inspection can create an empty provider
conversation without sending a model turn, so explicit selector activation and
the appropriate contextual ownership must govern that work; cold reopening
remains provider-free.

Review this expanded item 8 one member at a time: selection-surface placement,
agent selection/established-conversation identity, model choice, thinking effort,
application timing/retention, and unavailable-agent recovery. Agent changes must
not silently replace the retained provider conversation promised in item 1.
The Product Owner accepts Configure in the Sidekick header opening this drawer
inside the Sidekick pane. Exact change/reset behavior and internal configuration
records are not selected by that placement decision.

### Accepted agent-change identity

Choosing an agent before the first conversation establishes that agent's
Sidekick conversation. Model and effort can change within the same provider
conversation through Core's existing verified configuration contract. Changing
the agent after a conversation exists cannot reuse that other agent's provider
identity; it is not an in-place model selection.

The accepted decision makes an agent change an explicit start of a new Sidekick provider
conversation, with the prior chat retained and its original provider association
kept truthful. The REPL's logical Sidekick owner remains attached to the same
REPL session; reopening restores the active conversation selected by that
explicit action. No provider identity is silently substituted and prior chat
is not silently replayed into a new agent as though it were the old conversation.
The drawer must make the new-conversation effect clear when applying an agent
change. Exact retained conversation records and application timing follow this
identity decision. The Product Owner accepts this explicit agent-change behavior
in conversation. Item 1's continuity promise now restores the active provider
conversation while retaining prior associations truthfully.

### Accepted model/effort timing and retention

Model and effort selection reuse the existing provider-advertised choices and
Core's verified in-place configuration contract. Changing a model refreshes its
effort choices; unsupported settings remain unavailable. These are conforming
uses of existing interfaces, not new model or thinking APIs.

The accepted decision saves selected model/effort preferences with the retained Sidekick
conversation and applies them to its next provider turn. Changing them does not
interrupt a currently generating response, an executing response program or an
admitted entry. If Sidekick is waiting for entry completion, the next automatic
follow-up uses the new settings only after exact provider validation/application.
Reopening restores the preferences and waits for explicit continuation under
item 1; it does not apply settings or contact the provider merely to render chat.

Keep requested/pending preferences distinct from verified applied settings in
the UI and retained records. A rejected choice reports its reason and starts
no turn under a silently substituted setting. Application and readback use
Core's existing transaction/identity rules. The Product Owner accepts this
timing and retention in conversation; busy agent-switch behavior is reviewed
separately.

### Accepted agent switch while Sidekick is busy

Changing agents already requires an explicit new conversation. If Sidekick is
generating, evaluating a response, awaiting an answer or waiting for its entry,
the accepted action reads Stop and start new conversation. It stops and joins
the current Sidekick work using the accepted Stop boundary before changing the
active conversation. An already admitted REPL entry continues independently.

The previous chat and its provider association remain retained. The new
conversation does not send a model prompt until an explicit message or
continuation. The Product Owner accepts stopping current Sidekick work before
starting the new conversation while preserving an admitted entry and prior
chat. Unavailable-agent recovery separately preserves the previous active
association when initializing the new agent fails. Exact durable switching and
failure records remain architecture work.

## Item 9 of 9: narrow composition and visual adaptation

Status: narrow Sidekick access, wide/medium Bindings and Sidekick tabs and the
stronger browser reference boundaries are accepted. Sidekick is accepted as
the new-session right-tab default. Resize mapping and chat focus on explicit
activation and chat draft behavior while busy are accepted. Streaming preview
semantics are accepted; agent instructions are reviewed next before product
verification.

At 72×20 the existing REPL mounts one routed surface under Sessions and Entries
controls, with no inspection column. Its seven-row footer retains the action
row, five History rows and the shared entry draft. Architecture rules 9, 15,
16 and 21 settle root-owned navigation and the complete absence of unselected
surfaces from drawing, focus and pointer targets; these are conforming choices
and need no new approval.

The accepted narrow layout adds Sidekick beside Sessions and Entries. Selecting
it uses the main content area for the chat, work status, Stop, Configure and a
separate chat input. Its question/configuration drawers stay inside that area.
The ordinary entry draft, History and Exit remain reachable in the existing
footer. Selecting Entries returns to the REPL reading without stopping Sidekick
or changing either draft. Background activity never changes the selected
surface. Bindings inspection remains a wide/medium pane under the existing
narrow contract; Sidekick can inspect current bindings through its control.

The Product Owner accepts this narrow layout in conversation. Exact route
encoding, resize recovery, initial tab selection, focus restoration and measured
terminal placement follow the access decision and the final #881 base.

### Accepted initial tab selection

For a new REPL session at wide/medium sizes, select Sidekick in the right pane
so its purpose and separate chat input are immediately visible. Bindings remains
one tab away. Showing the pane does not start a provider turn or move focus from
the ordinary entry draft. At narrow sizes, retain the existing initial Entries
surface; Sidekick is reachable through the accepted navigation.

Reopening a retained location restores its saved presentation selection rather
than resetting it to this new-session default. The Product Owner accepts Sidekick
as the initial right tab. Provider-free display and root-owned selection reuse
the accepted lifetime and architecture contracts.

### Accepted resize mapping

The selected reading and the selected right tab are distinct presentation facts:
a wide frame can show Entries with the default Sidekick tab beside it. Merely
showing that default tab does not select the narrow Sidekick surface. An explicit
Sidekick activation selects its reading; Entries and Sessions activation select
their own readings. These root-owned choices determine the one narrow outlet.

If Sidekick is the selected reading, shrinking the terminal shows Sidekick in
the narrow content area; growing it returns Sidekick to the right pane. If the
selected reading is Entries or Sessions, shrinking retains that outlet even
when Sidekick is visible beside it in the wide frame. Explicit navigation alone
changes that selection; background work and resize do not. Both drafts, chat,
work and pending questions survive resize. The existing undersized refusal and
recovery remain, with absent controls excluded from focus and pointer targets.

Root ownership, absence and preservation reuse architecture rules 9, 15, 16 and
21. The Product Owner accepts the Sidekick-to-narrow mapping in conversation.
Exact focus fallback follows the existing mounted-tree behavior rather than
transferring input to an invisible composer.

### Accepted chat focus on explicit activation

With no drawer open, explicitly selecting Sidekick focuses its separate chat
input, labeled Message Sidekick. Sending a message keeps focus there. Showing
the default tab when a session opens does not itself move focus from the ordinary
entry draft. A Sidekick control that fills that draft never changes keyboard
focus; editing the shared draft remains an explicit human action.

The ordinary footer field keeps its existing Draft label. Opening a question
or configuration drawer follows existing mounted modal focus and restoration;
an already open drawer retains its own focus rather than routing input through
it into chat. Removing a tab's presentation removes all its input targets under
the approved absence rules. The Product Owner accepts this focus behavior in
conversation. Exact semantic actions and focus claims remain delegated
through Freedom and the root's existing application boundary.

### Accepted chat draft while busy

The accepted execution boundary runs one Sidekick cycle at a time, including
blocking on its submitted entry, and permits Stop without cancelling that entry.
The accepted chat presentation keeps Message Sidekick editable during that
cycle but disables Send, with the current work status and Stop visible. The
person can prepare the next message without queuing another turn.

When the cycle finishes or Stop completes, Send becomes available if the selected
conversation can accept a turn. The prepared message remains a draft until
explicitly sent; completion never sends it automatically. Failed or refused
send admission preserves the draft, and admission clears only the exact message
revision sent, preserving newer text. Tab switches and resizing retain the chat
draft under the accepted presentation ownership. The Product Owner accepts
preparing messages while busy with explicit Send afterward. No durable
unsent-chat-draft storage is selected by this presentation decision.

## Accepted agent instructions and initial syntax

Product-interface rule 5 requires reviewing the internal agent prompt because
it shapes the product's output. The closest existing constrained provider
pattern is plan-writer-profile.ts; its Plan-only ownership and response budget
are not copied into Sidekick. sidekick-instructions-proposal.md presents the
exact proposed agent-facing text using the accepted controls and source pattern.

The instructions distinguish user Output from automatic operation feedback,
teach current binding reads, actual shared-draft submission and bounded output
reads, preserve manual takeover and ordinary admission, and require truthful
revision from results. They introduce no new control or permission. The host
supplies admitted component references and ordinary entry vocabulary separately;
exact feedback records and the generated response-root seam remain under review.
The Product Owner accepts this instruction text with the explicit requirement
that available syntax is supplied the first time. Before the first provider turn
of each conversation, deliver the instructions and actual syntax reference
alongside the person's message and current shared draft. The agent does not
spend an initial turn discovering its vocabulary.

Distinguish the admitted Sidekick response vocabulary from the active REPL entry
vocabulary. Use Core's canonical SyntaxReference/inspectSyntax rendering and
captured profile inputs rather than a handwritten prompt catalog or the generic
run profile. Include exact control forms, props, captures, returns and usage
documentation. Entry component documentation does not authorize response
execution; reference text grants no capability. Preserve existing origin-only
inspection semantics.

Retain the reference actually delivered with the owning conversation's history.
Every explicitly new agent conversation receives an initial packet. Reopening
the same conversation does not resend it merely because the process restarted;
it still waits for explicit continuation. Recognizing changed syntax and exact
reference records are completed with the pending persistence/compatibility
boundary, rather than treated as an accepted silent refresh policy.

## Reference correction

reference/ now includes the previously accepted repl-sidekick-clear-columns.html
and reviewed Sidekick/Bindings browser captures. Its README records the exact
styling refinement and its checksum manifest verifies all five artifacts.
Terminal adaptation and production captures remain open. This correction
settles no scripted behavior from the mockup.

## Continuity

The reviewed packet identifies research main as
20462295c2ac44305577359583be0a33004cc428 and local production inspection as
2d719f78025059158a35023701fdff52b855a65b. The journal and observer findings above
are checked against that local source. This is an architecture interview, not
a feedback-commit verdict or a finalized implementation handoff.

Story #883 and predecessor #881 are read during this review; no GitHub mutation
or CI inspection occurs. No production source changes or runtime tests occur.
Accepted in conversation: reopening the same REPL session restores the same
Sidekick, History inspection leaves its conversation live, and reopening waits
for explicit continuation of Sidekick work. Separate Sidekick conversation
history and XMD-only Sidekick actions with no native tools are accepted. Next
action: review part 2 of the four remaining boundaries in
remaining-architecture.md: operation feedback, starting with the correlation
presentation and binding snapshot. The Product Owner rejects the amount of
receipt metadata and accepts a single raw value, with short component headings
only for multiple results and clear failure labels. Identity correlation remains
internal. EntryInput acknowledgement, raw Syntax reference and validated Elicit
answer apply that accepted presentation without a new product choice. Next
review: complete the feedback contract and move to durable recovery. EntryOutput's
bounded read message and Submit's exact-entry completion/read instruction are
accepted. The 4096-code-point chunk is an initial engineering choice, not a
measured optimum or a model/engine limit; it bounds individual reads, not output
production or cumulative reads. The Product Owner accepts larger reads through
limit; the simple feedback boundary is complete. Next review: part 3's proposed
interruption behavior, followed by storage/identity/reconciliation/compatibility.
Product verification follows.
The Product Owner asks how response syntax and entry-draft syntax are
distinguished and accepts explicit execution-context labeling and the
REPL.Syntax lookup. Syntax keeps its current-context contract; REPL.Syntax reads
the active entry vocabulary as operation feedback. Its named form reuses
canonical Syntax's schema and documentation semantics. The Product Owner accepts
the Core/CLI split: Core validates and evaluates restricted generated response
roots; CLI owns REPL controls; entries keep ordinary syntax and permissions.
Agent instructions and initial syntax delivery are accepted. The streaming preview/final-text distinction
is accepted. Item 8's unavailable-agent
recovery and item 9's busy-composer behavior are accepted.
Model/effort preferences are retained with the conversation and apply on its
next turn without interrupting current work.
Blocking until submitted-entry completion is accepted for this version.
The entry selector is optional, negative entry indexes select earlier entries,
and negative output offsets count from the end of the selected entry's output.
Stop Sidekick leaves
admitted entries running, and no fixed iteration cap applies. Automatic
continuation and the streaming experience are accepted.
Submission returns the exact
entry's finished result after teardown. The current-root binding
target includes acknowledged exports from running entries; a separate
historical-read syntax is a suggested follow-up.
Complete storage/correlation/compatibility after the dependent interfaces are
settled. Acceptance remains unfrozen.
