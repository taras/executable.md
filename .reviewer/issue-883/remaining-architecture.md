# Completing the Sidekick architecture

**Product Owner spelling correction, 2026-10-15:** use `--sidekick-agent` and
`sidekickAgent` throughout active implementation and instructions. This supersedes
the earlier exact-spelling instruction. Selection, ownership and persistence
contracts are unchanged. See
[the current correction](pr2-terminal-completion-implementor-correction-d634b28b.md).

This record completes the remaining #883 boundaries before final planning.
Accepted behavior is in architecture-review.md. The review has four parts:

1. Generated response admission and evaluation.
2. Exact operation feedback and correlation.
3. Durable conversation storage, interruption recovery and compatibility.
4. Product verification and terminal reference adaptation.

The interview is complete. planner-handoff.md consolidates the accepted design,
core-interfaces-proposal.md records the accepted Core interface, and
storage-contract.md derives publication and record mechanics from the accepted
ownership/recovery rules. All twelve product journeys below are accepted.

The accepted [syntax discovery amendment](syntax-discovery-amendment.md) revises
the first-turn context, guide/environment reads and journey 10 in this record.

## 1. Accepted generated response boundary

### Accepted syntax destinations

The Product Owner accepts the distinction between syntax used to communicate
with the runtime and syntax written into the REPL draft, including Syntax for
the current response context and REPL.Syntax for the entry context. These are
two execution contexts of XMD with separately derived vocabularies.

| Context | Where source goes | What authorizes execution |
| --- | --- | --- |
| Sidekick response | The generated response root. | Its pinned response ceiling and complete-source admission. |
| REPL entry | The shared draft as literal source. | Ordinary entry admission after an explicit Submit or human Run. |

The accepted first-turn orientation/index names both destinations. Detailed
guides and entry references are requested on demand. A common name such
as Output or Let has its canonical meaning within the document executing it:
Output in the response is person-facing Sidekick text; Output inside stored
entry source belongs to that entry when it runs. Filling the draft executes
none of its source. Repository and plugin components available to an entry are
not thereby available to the Sidekick response.

Canonical Syntax retains its existing contextual contract: within a Sidekick
response its bare form describes the response vocabulary. Its ordinary return
is not intercepted as generic agent feedback. As an accepted separate read
control, REPL.Syntax describes the active REPL entry vocabulary through the same
canonical reference machinery and returns it through Sidekick operation
feedback. Its self-closing form accepts an optional names list for selected
component documentation, parallel to Syntax's named form. It executes no entry
source and grants no capability. The optional named lookup and ordinary as
capture reuse Syntax's established schema and reference semantics under the
approved interface/architecture reuse rules.

The lookup and explicit destination wording settle this clarification; the
generated-root responsibility split is accepted separately. Existing Syntax documentation can explain
components unavailable in the current evaluation; destination labeling prevents
that knowledge from being mistaken for response permission.

### Evaluation responsibilities

A complete Sidekick reply is a generated XMD root. Core validates the entire
source before executing it, including paths the program does not take, and
admits only the host's pinned component identities and forms. The CLI supplies
the controls and owns their connection to the active REPL. A response is not
passed to the ordinary trusted-document executor as authored program source.

The canonical Core root supports ordinary top-level Output selection and
sequencing. Content and Return remain unavailable because this response has
neither caller-projected content nor a value-root contract. Executable fences,
JavaScript expressions, component definitions and unpinned component resolution
are unavailable in response source. Passive source fences, declarative data,
bindings created inside the response and existing generated composition remain
available under their canonical rules. The initial binding environment is empty;
REPL values reach the response through an admitted read, not ambient scope.

The Sidekick ceiling has these exact component forms:

| Class | Component | Form and operation |
| --- | --- | --- |
| Read | REPL.Bindings | Self-closing; current published root snapshot. |
| Read | REPL.EntryOutput | Self-closing; bounded observed entry output. |
| Read | REPL.Syntax | Self-closing; active REPL entry syntax and named documentation. |
| Read | Syntax | Self-closing; canonical current-context text reference, without automatic operation feedback. |
| Read | Guide.Entries, Guide.Bindings, Guide.Effection, Guide.Lifetimes, Guide.Recovery, Guide.Environment | Self-closing, no component-specific props; literal chapter text as designated feedback. |
| Read | REPL.Environment | Self-closing, no component-specific props; observed host-known facts and explicit unknowns as designated feedback. |
| Write | REPL.EntryInput | Paired; fill the actual shared draft. |
| Write | REPL.Submit | Self-closing; ordinary draft admission and exact-entry completion wait. |
| Write | Elicit | Canonical paired form; Sidekick-owned validated question. |

The host selects both read and write classes for the response. It supplies no
File, Glob, process, network, Agent or repository component entry. Syntax can
describe ordinary entry components without admitting them in a response.
Unavailability is enforced by admission, not by the agent instruction text.

Core owns the generated-root context, canonical validation, pinned resolution,
declarative expression evaluation, ordinary Output selection, retained admission
and exact policy comparison. The new root context is retained as part of the
admission policy so it cannot be confused with an older fragment admission.
Existing fragment records and Evaluate retain their released semantics.

The host-facing evaluation operation returns Effection Result with the rendered
selection and whether the root declares Output. A generated-request refusal
carries canonical safe diagnostics; runtime failure preserves any evaluated
partial selection in its Error data. Durable/policy/teardown failures retain
their existing authoritative failure classification. Generic root fallback
output is not changed: Sidekick's presentation reads the declared-Output fact
and suppresses fallback body text when there is no Output.

The Core interface uses the established host-captured evaluation profile and
canonical protected component-answer seam. It does not expose protected Elicit
as a copied function body or recover authority from replaceable context. The
Planner traces the smallest extension of those existing seams; the generated
root is a required Core capability, not a CLI parser or a second XMD evaluator.

Each admitted response executes in a scope owned by its Sidekick cycle. All
controls use a revocable host connection to that owner and pass root readiness
and draft-revision checks at admission. The scope finishes and joins before
feedback starts another provider turn. Stop revokes it and joins it while an
already admitted ordinary entry continues under the entry owner.

Streaming preview is presentation only. Incremental syntax recognition uses
Core's canonical scanner/parser with an explicit incomplete result. Only
unambiguous literal top-level Output content is previewed; it grants no
capability and obeys disclosure checks. Computed or uncertain portions wait.
Successful evaluation replaces preview with canonical selected text in the
same response item; unsuccessful generation labels it Incomplete. Runtime
evaluation failure shows actual partial selected output and failure status.
The generic Output engine remains buffered.

The Product Owner accepts this Core/CLI responsibility split: Core validates
and evaluates the restricted generated response; the CLI owns its REPL control
connection. Ordinary entry syntax and permissions retain their own boundary.
Exact feedback records and durable interruption handling are reviewed in parts
2 and 3 rather than delegated as implementation choices.

## 2. Accepted operation feedback

Feedback is host-authored data delivered to the owning provider conversation
after the response scope finishes and joins. It is not user Output and is not
an XMD program for the agent to evaluate. Review these eight members:

1. Internal response/operation correlation and ordered agent-facing delivery.
2. Bindings snapshot value.
3. EntryInput draft receipt.
4. Submit entry completion receipt.
5. EntryOutput bounded read receipt.
6. REPL.Syntax reference value.
7. Validated Elicit answer.
8. Response/operation failures and interrupted work.

The syntax-discovery amendment adds the six guide chapter results and the
REPL.Environment snapshot to the designated read feedback set. They use the
same retained operation ordering, failure behavior and conversation ownership;
ordinary component returns still do not become feedback.

### Accepted simple feedback and bindings value

The Product Owner challenges the nested receipt as too much for the agent to
parse. Withdraw the proposed response/results/operation/result envelope from
the agent-facing message. The accepted design sends a single successful
operation's value directly. For REPL.Bindings, the message contains:

```json
{ "names": ["Ada", "Grace", "Linus"] }
```

When several operations run in one response, deliver their results together
in invocation admission order, each under a short component-name heading.
Keep JSON values in fenced blocks and use fences longer than any content run;
plain reference text retains its canonical formatting. A failed operation is
explicitly labeled with its component and failure reason. Do not disguise a
failure as a successful returned binding named error. The formatter adds no
response IDs, operation IDs, outer success wrapper or generic value field.

The runtime retains response and invocation identities internally within the
owning conversation. Retained invocation identity, rather than a displayed
ordinal, correlates attempted operations and recovery. Reuse the durable
stream's serialized Result representation for retained operation outcomes;
production operations return Effection Result and failures belong on Error.
The runtime derives the simpler agent-facing message from those records rather
than using the presentation as persistence or interpreting it as executable XMD.

REPL.Bindings returns a detached JSON object mapping published binding names to
their current values. An empty snapshot is an empty object. It excludes props,
live environments and execution capabilities. Historical selection does not
change the target; already acknowledged values from running entries are included.
Keep the authoritative observed Journal prefix in the retained operation record
for correlation, outside this value. Do not inject provenance or a status into
the binding object as though those were REPL variables.

Only designated controls record this operation feedback. Ordinary component
returns, including canonical Syntax, are not intercepted. The runtime seals the
batch from retained operation outcomes before its next provider turn; tabs and
render subscriptions do not send another copy or start another turn. Exact
interruption/delivery reconciliation follows part 3.

The Product Owner accepts the simple binding value, short headings for multiple
results and clear failure messages. Internal identity and disclosure invariants
remain required even though they are omitted from the agent-facing presentation.

### Conforming simple control results

The same accepted presentation supplies these results without another envelope:

| Control | Successful value delivered to Sidekick |
| --- | --- |
| REPL.EntryInput | Entry input updated. |
| REPL.Syntax | Canonically rendered entry syntax or selected component documentation. |
| Elicit | The validated JSON answer. |

These apply the accepted raw-result presentation and existing operation meanings,
under product-interface rule 6 and architecture rule 3. EntryInput's internal
record retains its rendered source and actual draft revision for correlation;
the agent-facing acknowledgement does not echo that program. As-capture, where
available, captures the component's ordinary successful value inside the
response. Capturing does not disable the designated control's feedback record.
Generic component values still create no operation feedback.

### Accepted Submit completion message

After the exact admitted entry finishes and its task teardown joins, deliver a
short completion message and the canonical invocation for reading that entry:

```text
Entry entry-4 completed.
Read its output with <REPL.EntryOutput entry="entry-4" />.
```

An actual failed entry instead says Entry entry-4 failed: followed by its ordinary
safe diagnostic, then the same exact-entry read instruction. An actually
cancelled terminal says cancelled. Admission refusal says REPL.Submit refused:
followed by its reason and preserves the draft; it names no fabricated admitted
entry. No output body, preview, summary, admission-only acknowledgement or
unrelated entry outcome is added to the completion message.

The retained successful operation value carries the actual entry identity,
terminal status and read instruction; failures use Error data and the existing
Result representation. A submitted entry's script failure is an actual entry
outcome, distinct from refusing to admit an entry. Both remain truthful in
feedback and permit the already accepted ordinary-error correction flow.
Lifecycle/storage/policy/teardown failures retain their authoritative owner
classification and cannot be converted to a successful completion message.

The Product Owner accepts this completion message in conversation.

### Accepted EntryOutput read message

Deliver the requested text with a compact header identifying its actual entry,
the observed output range and whether the output is complete. For the default
tail of a completed 10000-code-point output:

````text
entry-4: output complete; characters 5904-9999.
```text
[the actual requested text]
```
Read earlier with <REPL.EntryOutput entry="entry-4" offset={1808} />.
````

Character positions are zero-based Unicode code-point offsets, consistent with
the accepted offset prop. The internal range uses start inclusive and end
exclusive; a nonempty message shows the last included position for readability.
Return at most the requested limit (4096 by default) and include earlier/later read
invocations when adjacent observed chunks exist. These use the resolved entry
identity and absolute offsets, regardless of the original relative selector.
Output text is literal data within an adequately long fence, never evaluated
as control source.

For a still-running entry, the header says output so far; entry still running.
Reaching the current snapshot's end is not described as completion. A terminal
root establishes that its output is complete; the read does not assert that the
entry's resource teardown joined. Submit still waits for that separate fact.
If a run is interrupted without a terminal outcome, report interrupted output
as incomplete. Reading starts or resumes no work and does not wait for output.

An empty output reports No output yet for a running entry or No output for a
terminal one. A positive offset at or beyond the observed end returns no text
and reports that offset and the observed character count. Negative positions
before the start clamp to zero under the accepted contract. With no entries or
an unknown/out-of-range entry selector, return an ordinary refusal explaining
that no such entry can be read; do not select a substitute. Unsupported zero or
positive integer entry selectors are refused; exact entry keys remain valid.

The retained read outcome stores the actual entry, observed Journal/overlay
basis, terminal fact, total observed length, resolved start/end and exact chunk.
Its read instructions are derived from that snapshot. The agent-facing message
contains only the text and useful read context, without correlation envelopes.
The Product Owner accepts this read-message presentation and asks why the
4096-character bound was chosen. It is an initial engineering choice, not a
measured optimum or a Core/provider/model requirement. It supplies a useful
bounded tail while preventing one read from attaching arbitrarily large output
to a provider turn. It limits one chunk, not total entry output or cumulative
reads. Unicode code points are neither bytes nor model tokens, so it does not
claim an exact byte/token budget. Changing this size remains an explicit policy
change rather than an inferred new settings surface. Empty/range handling
applies the accepted bounded snapshot semantics and clear-refusal rules.

### Accepted per-read character limit

The Product Owner requests and accepts a way to increase the character limit. The
EntryOutput prop is limit, a positive integer measured in Unicode code points,
defaulting to 4096:

```xmd
<REPL.EntryOutput limit={16384} />
<REPL.EntryOutput entry="entry-4" offset={0} limit={16384} />
```

With no offset, read the last limit code points of the observed output; this
keeps larger default-tail reads useful rather than starting only 4096 characters
from the end. An explicit signed offset keeps its accepted meaning, and the read
returns at most limit currently available code points from that resolved start.
If limit exceeds the available output, return only what exists. There is no
unbounded spelling. No additional feature-specific hard maximum is selected.

Read instructions carry the chosen limit and stable entry/absolute offsets.
The initial instructions teach starting with the default and requesting larger
chunks when more context is useful. Retained read outcomes include the actual
limit and range. This is per-operation syntax, not a general settings screen.
The Product Owner accepts limit, the default-tail behavior and adjustable read
size. This supersedes the earlier fixed 4096 maximum; bare EntryOutput retains
its latest-entry 4096-character tail.

### Conforming failures and complete feedback boundary

Structural response refusal supplies the canonical safe diagnostic and records
zero controls. An ordinary control failure is labeled with its component and
reason; the batch retains earlier actual successes in order. A failed entry
uses the accepted exact-entry outcome and read instruction. No prior effect is
rolled back or repeated, no raw error stack is added, and no generic component
return becomes an operation result. These follow accepted ordinary-error and
simple-feedback decisions; the agent receives them automatically after scope
teardown so it can correct its next response.

A terminal provider failure pauses with Incomplete preview and an actionable
error, executing no candidate source and waiting for explicit retry/message.
Stop withdraws unanswered requests and stops continuation without fabricating
an answer or changing an admitted entry's outcome. Infrastructure integrity,
policy, scanner and teardown failures keep their existing fatal-owner contracts.
Interruption is an absence of a completed operation, not a fake success/failure
receipt. Recovery of that absence follows the accepted part 3 contract.

The feedback member inventory is now covered by accepted meanings and
conforming presentation. Canonical component returns and their normal as
capture remain distinct from host feedback formatting and retained identity.

## 3. Accepted durable recovery

The reviewed members are interruption behavior, storage recognition/ownership,
provider association, control-to-entry reconciliation and compatibility/context
refresh. storage-contract.md completes their derived storage mechanics.

### Accepted interruption behavior

Reopening retains the chat and actual operation facts, performs no Sidekick
provider turn or response execution, and follows ordinary entry reconstruction
independently. Sidekick does not restart the old response
program after explicit continuation. Instead it reconciles what that response
already did, reports completed effects and interrupted work to the same
conversation, and lets the next explicitly requested turn author a new response.

For example, if the process ends after Submit admits entry-4 but before its
completion feedback is retained, reopening recognizes that exact entry. It does
not submit the source again. The next explicit message/continuation gives the
agent its actual known status and exact-entry output-read instruction. An
unfinished entry follows existing REPL recovery; a terminal entry is not rerun.
Neither its completion nor process reopening automatically starts Sidekick.

Partial provider source executes nothing. A complete response whose later
controls never ran is not resumed by replaying its unexecuted suffix. A pending
question is identified as interrupted without retaining a live request or
manufacturing an answer; the new response can ask it again if needed. Completed
validated answers and operation observations remain retained facts. UI drafts
are restored according to their established location/process ownership rather
than by replaying an old EntryInput over the current shared draft.

An explicit continuation report uses the accepted simple feedback presentation,
not raw record IDs. Unknown effect status refuses to guess or repeat the action;
the exact admission reconciliation is reviewed with storage. The Product Owner
accepts paused reopening and a fresh response on explicit continuation, with
no repeated admitted entry or replay of an unexecuted response suffix.

### Accepted storage recognition and ownership

Today each execution has one `<execution>.jsonl` file containing only ordinary
entry events. Adding an optional neighboring Sidekick file leaves an ambiguity:
an absent file could mean an older execution that never had Sidekick, or lost
history for an execution that already owns a provider conversation. Treating
both as a new conversation violates the accepted reopening behavior.

Give each newly created execution a versioned session directory containing two
required histories: `entries.jsonl` and `sidekick.jsonl`. The entry history keeps
its ordinary event grammar and remains authoritative for source, execution and
outcomes. Sidekick history retains its owner/version, conversation associations,
chat and operation facts. Its record contract is reviewed separately; the
directory introduces no projected model, cache, checkpoint index or UI state.

The contextual storage root and opaque execution identity remain authoritative.
Create both required histories and establish their ownership before exposing a
new session or starting provider work. An incomplete directory, missing required
history or conflicting ownership is refused rather than overwritten or treated
as a fresh conversation. Reading follows existing regular-file, complete-record
and safe-diagnostic rules. Cold opening does not append or call a provider.

The Product Owner accepts the paired histories and refusal to silently create
a replacement conversation when required Sidekick history is missing. The exact
path convention and retained record requirements are completed in
storage-contract.md; existing-file transition is accepted below. Existing entry
files are not silently migrated or overwritten by cold opening.

### Accepted transition for existing sessions

An existing single-file execution remains readable at its same location without
conversion, provider work or history writes merely because it was opened. Its
ordinary entry behavior remains available. It has no prior Sidekick conversation
to restore, and the Sidekick pane says that its first message starts one.

The first explicit Sidekick message establishes the paired histories before
provider work. It preserves the execution identity, existing location, entry
order, entry identities, source and retained outcomes. It copies existing entry
records exactly and executes none of them as part of the transition. Subsequent
reopening restores that new Sidekick association under the accepted rules.

Publication must distinguish an established pair from an incomplete transition.
The original entry history remains recoverable until publication succeeds;
failed or interrupted preparation does not expose partial histories as a valid
pair, lose entries, append the same entries twice or start a provider turn.
Recognition of a retained original alongside the published pair requires an
explicit, verifiable origin association rather than guessing which is current.
The Product Owner accepts this first-use transition. storage-contract.md derives
its publication and recognition protocol. No separate migration command or
confirmation screen is required.

### Provider association follows the existing retained-session contract

The accepted same-conversation requirement uses Core's canonical retained-session
identity and provider assertion, not the chat transcript, an authored session
name or a provider-store lookup key. The association belongs to this execution's
Sidekick history and distinguishes each explicitly selected new conversation.
The ordinary entry journal does not acquire a synthetic Session entry to hold it.

Before a continuation turn, compare the retained provider, resolved agent
command, canonical native identity kind/value and retained effective configuration with
the provider's assertion. Reattach only the same conversation under an
established compatible configuration. Creation establishes the initial configuration; it does
not make MCP, native-tool or permission settings permanent conversation identity.
A supported configuration change preserves the same native conversation after the
provider applies and verifies it and Core retains the resulting effective
configuration. An unsupported change refuses without silently replacing the
conversation or claiming the requested settings took effect. Live-update
controls and their protocol are outside this PR; the accepted ownership,
lifecycle and interfaces are recorded in
[the configuration amendment](pr2-recovery-creation-policy-architect-decision.md)
and [Planner handoff](pr2-session-configuration-planner-handoff.md).
Core commits the provider-declared initial configuration in the conversation's
canonical history before native creation can begin. The installed provider
calls the genuine placement's activate operation before reattachment;
incompatible configuration refuses without replacement. Configuration capture
does not assert native creation, successful application or backend acceptance.
An absent mapping with no assertion permits first creation; one canonical
assertion before mapping completion reconciles to that identity. Missing,
multiple or changed assertions for an established association refuse replacement.
Record the association before presenting produced response source or admitting
its controls. Never rebuild a conversation by replaying old chat into a new one.

These preserve specs/acp-client-spec.md's retained-session identity contract and
amend its configuration boundary for Sidekick's strict reopening behavior.
They require a canonical
Core-owned association seam for Sidekick's independent history; they do not
authorize the CLI to manufacture a claimant, copy a private mapping algorithm
or trust replaceable context state. The accepted ProviderSessionConfiguration
and AgentSessionPlacement.activate boundary is ready for Planner incorporation;
its implementation and focused evidence remain pending.

Explicit agent changes retain prior conversations and establish a new one under
the accepted Configure behavior. Model/effort changes use the existing verified
configuration transaction for the same native conversation. Cold reopening
creates neither a provider session nor a turn merely to check identity; checking
occurs when an explicit action requires provider work.

### Accepted syntax-reference refresh

The initial orientation/index identifies both response syntax and active entry
syntax before a conversation's first turn. It supplies the help requests and
compact canonical response surface; full guide chapters and entry references
are read on demand. If compatible syntax or guides change, supply the relevant
updated orientation/index context before the next explicitly requested turn in
that same conversation. Retain exactly which context/version was supplied so
reopening alone sends nothing and makes no provider call. Guide reads and
REPL.Syntax inspect the active captured assets/profile during an active cycle.

A refreshed reference is context, not permission. It cannot widen the pinned
response ceiling or override retained provider configuration. A change incompatible
with the verified effective configuration refuses continuation unless a supported
update establishes the changed configuration on the same conversation. This does not
authorize automatic replacement. The Product Owner accepts compatible
syntax-reference refreshes, such as a newly available entry component, before
the next explicit turn in the same conversation.

### Accepted Submit reconciliation between histories

The entry journal remains the authority on whether an entry was admitted. A
Sidekick receipt alone cannot prove that a missing receipt means no submission:
the process can stop after the entry admission reaches disk but before that
receipt does. This is the remaining ownership boundary between the two histories.

Before admitting a Sidekick Submit, the root reserves the next entry position
and retains the intent in Sidekick history: the owning response and operation,
the exact proposed source, the existing entry-journal prefix and the reserved
entry identity. Only that request can admit into its reserved position. Ordinary
human submission uses the same root gate and cannot take that slot while the
intent is unresolved. This short admission reservation introduces no queue and
does not wait for entry completion; after admission the ordinary running-entry
guard applies. Draft editing and Stop remain responsive.

The reservation follows normal preflight and is checked again at actual
admission against source immutability, draft revision, Live view, request
liveness and session teardown. Stop or manual takeover before admission prevents
the entry from starting even if an earlier check passed. Neither path can cancel
an entry that has already been admitted.

On reopen, compare an unresolved intent with the authoritative journal before
allowing any new admission. An unchanged prefix with no reserved entry means it
was not admitted. The exact reserved entry following that prefix with matching
source proves which entry was admitted; its current outcome is read normally.
A changed prefix, mismatched source or incomplete/corrupt history refuses to
guess or repeat. No content-only search for a similar entry substitutes for the
reserved position and prefix.

Cold reopening projects these facts without writing a receipt or starting work.
Before a later explicit mutating action admits another entry, retain the resolved
intent so its slot cannot subsequently be mistaken for a new submission. The
next explicit Sidekick turn receives the actual status under the accepted
interruption policy. An unadmitted intent is reported as interrupted rather than
automatically submitted, and an admitted entry is never submitted again.

The Product Owner accepts retaining Submit intent before admission, reconciling
it against the exact reserved entry and refusing disagreement without guessing
or resubmitting. The root's brief admission reservation is required to make that
comparison authoritative while leaving the entry journal's grammar unchanged.

## 4. Accepted product verification

The twelve journeys are accepted. The completed Core interface and storage
contract accompany them in planner-handoff.md. The Planner derives finite
implementation evidence and captures without reopening settled product behavior.

### Accepted journey 1: Sidekick drives and revises a real entry

1. Publish a names binding containing Ada, Grace and Linus through an ordinary
   entry. Ask Sidekick to create greetings from the available names.
2. Sidekick inspects the published binding, fills the actual shared program
   draft and submits through ordinary entry admission. A real new entry renders
   greetings for those names; its retained source is the same source placed in
   the draft. Filling the draft alone executes nothing.
3. Ask for a table revision. The same Sidekick conversation produces and submits
   the revised program as another real entry. Its output is the requested table,
   and the earlier entry remains unchanged.

The verification compares the binding value observed by the agent, the actual
shared draft, admitted source, execution output and provider conversation across
both turns. Changing the published names changes the resulting program/output.
Canned chat, a private agent draft, simulated execution or a fresh conversation
for the revision cannot satisfy this journey. The Planner derives finite
lower-level evidence from the approved journey; those commands are not selected
by this product review.

The Product Owner accepts this journey as verification of the basic discuss,
execute and iterate experience.

### Accepted journey 2: A human edit takes over the shared draft

Start Sidekick work and edit the program draft before its pending replacement or
Submit is admitted. The exact human text remains in the shared draft; stale
Sidekick work neither replaces it nor starts an entry. Reads and chat may finish,
but automatic program changes remain paused until the next explicit Sidekick
message or continuation. A human Run admits the current draft through ordinary
entry guards.

Exercise the other side of admission too: after an entry is admitted, type a new
draft before the earlier submission's acknowledgement is handled. The admitted
entry keeps its immutable source and continues; the late acknowledgement does
not clear the newer draft. The next explicit Sidekick instruction starts from
that current draft rather than restoring an older agent copy.

The verification compares exact draft revisions, admitted source and entry
count across both timing boundaries. A visually shared input backed by a hidden
agent draft, a check performed only before asynchronous preflight or a delayed
acknowledgement that erases newer text cannot satisfy this journey.

The Product Owner accepts this journey as verification of manual takeover and
protection of newer draft revisions on both sides of entry admission.

### Accepted journey 3: Waiting and Stop during a long entry

Ask Sidekick to submit an entry whose work remains running long enough to
inspect the interface and whose emitted output exceeds one default read chunk.
The ordinary REPL shows the real entry and its emitted output. Sidekick says it
is waiting for that exact entry, with no active model generation or polling
turns. The person can inspect the REPL and answer entry-owned questions.

In the Stop branch, activate Stop while Sidekick waits. Sidekick's wait and
automatic continuation end promptly, while the admitted entry keeps running.
The chat and current shared draft remain. No entry-cancel outcome or question
answer is invented, and a later entry completion does not restart Sidekick.
Also stop before actual admission: no entry is started by a stale response.

In the completion branch, let the entry finish. Keep resource teardown pending
after its output closes; Sidekick remains waiting until the exact entry's
resources have joined. Then it receives that entry's actual status, identity
and output-read instructions, without automatically receiving the output body
or a summary. It can explicitly request the tail or larger chunks afterward.

The verification distinguishes model generation from host waiting, observes
provider traffic and exact entry ownership, and checks UI responsiveness while
work is held. A spinner over continuing provider calls, a Stop that cancels the
admitted entry, a completion based only on root output closing or an automatic
dump of all entry output cannot satisfy this journey. Work can be held at real
boundaries to verify the behavior without requiring a two-hour wall-clock run.

The Product Owner accepts this journey as verification of truthful waiting,
responsive Stop, independent admitted work and completion after exact teardown.

### Accepted journey 4: Streamed chat and operation feedback stay distinct

Ask Sidekick to inspect bindings. While the provider streams literal text inside
Output, the chat shows that text as Preview. The streamed response also contains
a binding read and a draft change; neither control runs while source is partial.
After the complete response passes admission, its controls run and canonical
evaluated Output replaces the preview in the same chat item.

The agent's next turn receives the actual binding value and operation outcomes
in order, through the accepted simple feedback presentation. They do not become
chat messages unless the agent explicitly selects them with Output. A response
containing controls alone still operates and delivers feedback; unwrapped body
text does not become fallback chat. An ordinary component return outside the
designated controls does not create feedback.

Interrupt or fail the provider before its response is complete. Its preview
becomes Incomplete and no control executes. Refuse a structurally invalid
complete response before any control executes. For a later runtime failure in
an admitted response, preserve its actual earlier effects and evaluated partial
selected output, with the truthful failure; do not show success for work that
did not complete or repeat earlier effects during correction.

Verification observes actual provider feedback, entry/draft effects and the
single chat item across streaming, admission and failure. Executing a tag as
soon as it streams, duplicating preview and final text, using generic generated
return interception or printing all operation results into chat cannot satisfy
this journey. Computed Output appears only when evaluation resolves it under
the accepted presentation contract.

The Product Owner accepts this journey as verification of explicit chat output,
complete-response control admission and separate ordered operation feedback.

### Accepted journey 5: Sidekick owns its question and answer

Have Sidekick ask a schema-validated Elicit question while an ordinary entry
also has a pending question. The Sidekick question is announced without changing
the current tab, focus or History position. Open it deliberately: its drawer is
inside Sidekick chat and is distinct from the entry-owned question.

Enter an invalid answer. Validation issues appear beside the relevant fields;
no answer reaches the agent and the question stays pending. Enter part of a
valid answer, close the drawer and switch tabs. Neither action answers or
cancels it. Reopen the drawer and see the same question and partly completed
fields, then submit a valid answer. Only the owning Sidekick conversation
receives it; the entry's question remains independently pending and answerable.

Repeat with Stop while the Sidekick question is pending. The question is
withdrawn without an invented answer, and the entry-owned question remains
available. Verification checks both owners' actual answer publication, retained
facts, mounted controls and focus. A simulated text question, validation bypass,
tab-owned cancellation or a shared answer slot cannot satisfy this journey.
Partly typed fields are retained within the process under the accepted contract;
this journey adds no durable form-draft requirement.

The Product Owner accepts this journey as verification of validated,
owner-routed answers and question preservation through closing and tab changes.

### Accepted journey 6: Live inspection and ordinary submission guards

Publish a binding in an entry, redefine it in a later entry and create a nested
binding with the same name. Select an earlier entry, scope and History position,
then ask Sidekick to inspect bindings with either right-hand tab selected. It
receives the current acknowledged root value, including a value published by a
still-running entry, rather than the selected historical or nested value. The
visible selection, History position, tab and focus remain unchanged.

Sidekick may prepare the shared draft while History is selected. Its Submit is
refused, starts no entry, preserves the draft and does not switch the person to
Live. Return to Live explicitly and request submission again; it can then use
ordinary admission when the execution is available.

Exercise submission while another entry is running and while its output has
closed but resource teardown is still held. Both refuse promptly without a
queued entry or a wait on that unrelated task. After teardown completes, a new
explicit submission can succeed. The same guards apply during session teardown.

Verification compares actual root snapshots, unchanged reading/focus state,
entry count, retained source, draft and operation refusals at each boundary. A
binding read taken from the visible pane, automatic navigation to Live, direct
session submission that skips root guards or admission after output close but
before cleanup cannot satisfy this journey.

The Product Owner accepts this journey as verification of live root inspection
without navigation and ordinary root-owned admission guards.

### Accepted journey 7: Read the requested entry output in bounded chunks

Produce output longer than 4096 Unicode code points, including non-ASCII text.
Ask Sidekick to read it. Bare EntryOutput returns the latest entry's last 4096
code points with its actual identity, observed range and ready-to-use adjacent
read instructions. A larger positive limit returns the requested larger chunk;
without an offset it still selects that many characters from the tail. A short
output is returned whole without padding or a summary.

Read from the beginning with offset zero, from the end with a negative offset,
and from an earlier entry with a negative entry index. Follow the provided
adjacent read after another entry becomes latest: it still addresses the original
entry by stable identity, uses an absolute offset and preserves the selected
limit. Character boundaries do not split a Unicode code point.

Read a running entry's already emitted output. The read returns promptly as an
unfinished snapshot, without running, resuming or waiting for that entry. A
later read may observe more output but does not change the earlier snapshot's
reported range. Output not yet emitted because of ordinary buffering is absent.

Exercise an empty output, an offset beyond the observed end and a missing or
out-of-range entry selector. Empty ranges are truthful; an invalid entry is
refused rather than substituted with another. Verification compares exact
returned text, ranges, identities and follow-up instructions observed by the
provider. An unbounded dump, byte-based slicing, summarized output, a shifting
latest target between pages or a read that waits for completion cannot satisfy
this journey.

The Product Owner accepts this journey as verification of bounded, stable-entry
output reads, configurable chunk sizes and truthful running snapshots.

### Accepted journey 8: Reopen the same Sidekick without restarting work

Use Sidekick across several entries, exit and reopen the saved REPL location in
a fresh process. The retained chat, actual operation facts and active provider
conversation association return alongside the same entries. A cold reopen of
settled work makes no provider calls, performs no response controls and leaves
both histories byte-identical. The next explicit message continues the same
native conversation rather than reconstructing chat in a new one.

Interrupt the process after Submit has admitted an entry but before Sidekick's
receipt is retained. Reopen paused: the journal identifies that exact entry and
no duplicate is admitted. On explicit continuation, report its actual status
and let the agent author a fresh response. An unfinished entry follows ordinary
entry recovery independently. An old response's unexecuted controls are not
restarted; a partial provider response executes nothing; a pending question
restores as interrupted rather than as a fabricated answer or live request.

Repeat with interruption before admission. The unadmitted intent is reported
truthfully and its source is not automatically submitted. Missing required
history, corrupt/incomplete records, conflicting owner data or a changed native
identity produce an actionable refusal without a replacement conversation,
overwrite or guessed effect. The native-identity check occurs only when explicit
provider work requires it; cold inspection remains provider-free.

For an older single-file session, cold opening changes nothing. Its first
explicit Sidekick message establishes paired histories while preserving the
same URL and exact entry records before provider work. Failed preparation keeps
the original history recoverable and starts no turn.

Verification compares files, retained identities, entry admissions and actual
provider traffic across fresh processes and interruption boundaries. A transcript
replayed into a new native session, automatic background continuation, inferred
success from a missing receipt or silent first-use history loss cannot satisfy
this journey.

The Product Owner accepts this journey as verification of paused reopening,
exact provider continuation, interrupted-effect reconciliation and older-session
first use without history loss.

### Accepted journey 9: Configure Sidekick independently of entry agents

Choose one entry default with --default-agent and a different Sidekick agent
with --sidekick-agent. Entry Agent work uses the former; Sidekick uses the latter.
Without an explicit Sidekick flag, verify its accepted environment/package
default rather than inheriting the entry default. Reopen an established session
and preserve its active association instead of silently replacing it with a new
command-line default.

Open Configure inside the Sidekick pane. Select a provider-advertised model and
thinking effort. Requested preferences are distinct from verified applied
settings; they affect the next turn without interrupting current work. Refresh
effort options when the model changes, show unsupported choices as unavailable,
and refuse rejected settings without silently substituting another value or
conversation. Reopen and retain the preferences without a background model turn.

Explicitly change agents. A new conversation starts, prior chat remains with
its original association and entry Agent configuration stays unchanged. While
Sidekick is busy, use Stop and start new conversation: its old work joins before
the switch, an admitted entry continues and no model prompt is sent until the
next explicit message. If initialization fails, the prior active association
remains. An unavailable agent shows its reason with Retry and Configure; retry
targets the same conversation and ordinary REPL work remains available under
existing CLI and integrity rules.

Verification observes actual provider/session identities, verified configuration
transactions, independent flags and retained chat associations. A shared default,
cosmetic selector, unverified applied label, in-place agent identity replacement
or implicit fallback after failure cannot satisfy this journey. Configure may
perform the accepted provider option inspection, but opening it alone sends no
model prompt.

The Product Owner accepts this journey as verification of independent defaults,
verified next-turn settings and explicit conversation changes without fallback.

### Accepted journey 10: Discover syntax and request the teaching needed

Send the first message in a new Sidekick conversation. Before its response, it
receives the short orientation, guide index and compact canonical response
surface, plus the current draft/request. It can write valid Output and help
requests immediately. It is told that response controls and literal entry source
have separate syntax destinations. The full chapters and entry catalog are not
loaded into its initial context.

Have Sidekick request the needed Guide.* chapter and continue from its feedback.
Read each chapter through the actual registered component, including two in one
response; results stay ordered and belong to the same conversation. Examples
remain literal, and documentation reads change neither draft nor entry count.
Guide.Environment teaches stable rules; REPL.Environment separately reports
observed contextual facts and explicit unknowns without probing native tools.

Use REPL.Syntax and its names lookup to inspect an entry-only repository/plugin
component. It appears in canonical entry documentation without becoming allowed
in a response. Prepare its source through passive capture and EntryInput, then
Submit under ordinary entry permissions. Filling the draft executes no source;
attempted response-side use is refused before effects.

Change compatible available syntax/guide metadata and send another explicit
message. Updated orientation/index context reaches that same conversation before
the turn; detailed references remain on demand. Cold reopening sends no context
or provider turn. A newly selected conversation receives its own bootstrap.

Verification observes actual provider input, canonical reference/guide results,
retained observations and real entry behavior. A handwritten drifting catalog,
full manual injected by default, documentation treated as permission, help whose
results never reach the agent or executed examples cannot satisfy this journey.
Review guide prose under .agents/agent-writing.md and walk an unfamiliar agent
through an entry task using the documented initial context; scripted transport
alone proves routing rather than teaching quality.

This journey incorporates the Product Owner's accepted progressive-disclosure
amendment. It retains separate syntax destinations, compatible same-conversation
refresh and the restriction on native Sidekick tools.

### Accepted journey 11: Correct ordinary failures and pause provider failures

Ask Sidekick to submit a program that fails. The ordinary failed entry remains
visible with its actual outcome. After exact teardown, Sidekick receives that
entry's failure and read instruction, then can author a corrected program and
submit it as a new entry through the same ordinary guards. It never rewrites
the failed entry or treats admission as success. A response validation error or
ordinary control refusal likewise supplies truthful feedback for the next turn.

In a response with an earlier successful effect and a later failed operation,
preserve and report both actual facts. Correction does not replay the earlier
effect. Manual draft takeover, History restrictions and Stop continue to apply
through automatic correction, which has no fixed iteration cap.

Fail the provider instead. Sidekick shows an actionable failure, marks partial
preview Incomplete, executes no candidate controls and pauses. Only an explicit
retry or message continues the same conversation. If the provider cannot assert
that identity, retry refuses replacement. Integrity, policy and teardown failures
keep their authoritative owner classification rather than becoming an agent
repair loop.

Verification observes actual failed outcomes, correction traffic, new entry
identities and preserved earlier effects. A scripted success after failure,
mutation of old entries, automatic retry of a terminal provider failure or
control execution from incomplete provider source cannot satisfy this journey.

The Product Owner accepts this journey as verification of truthful automatic
correction for ordinary failures and explicit continuation after provider failure.

### Accepted journey 12: Clear terminal layout with preserved interaction

At 160x36 and 120x30, distinguish the left reading/navigation column, central
entry reading and right inspection pane. The right pane shows either Bindings
or Sidekick with a selected-tab marker. Message Sidekick and the ordinary Draft
remain visibly different input destinations. Initial Sidekick tab visibility
does not take focus from Draft; explicit Sidekick activation focuses its chat
input, and an agent draft fill never moves focus.

At 72x20, Sessions, Entries and Sidekick select one main outlet. Sidekick's chat,
status, Stop, Configure, composer and drawers occupy that outlet; the existing
seven-row footer keeps the ordinary program draft, History and Exit available.
Unselected outlets have no rendered, keyboard or pointer targets. Bindings is
not an additional narrow outlet.

Switch tabs and resize while a turn or question is pending and both inputs
contain text. Retain the conversation, work, selected reading, drafts and question
fields. Selecting Sidekick before shrinking keeps it selected; merely showing
the default right tab does not replace an Entries reading on shrink. While busy,
chat text remains editable with Send disabled and Stop visible; finishing or
stopping preserves that text for an explicit Send. Background work never opens
a tab or drawer or changes History/focus. Resize below the supported minimum and
back without losing state or exposing invisible targets.

Map the accepted browser refinement to terminal cells: continuous one-cell
vertical separators distinguish the column edges, contrasting pane/header fills
preserve their hierarchy, and header/footer edges occupy existing chrome rather
than adding footer rows. Selected tabs, focus, work status and input destination
are also recognizable in text without color. Pixel widths and rounded browser
chrome are not terminal dimensions. Sidekick question/configuration drawers use
the accepted pane-local placement.

Verify the actual production terminal frames and interactions at all three
profiles, comparing them with the pinned accepted browser reference and this
explicit adaptation. Cover empty chat, a populated draft, generation/waiting,
both right tabs, a question with invalid and partial answers, failure/Stop and
History inspection, plus populated-question resize refusal/recovery. The Planner
derives a finite capture matrix with exact actions and revision provenance.
A browser-only mock, two drawn tab contents, unclear column edges, hidden active
targets or lost drafts on resize cannot satisfy this journey.

The Product Owner accepts this journey and the explicit terminal adaptation of
the browser reference. All twelve product-verification journeys are accepted.
The Planner derives finite tests and captures from the completed architecture
handoff; implementation acceptance remains its next responsibility.

## Source evidence

At the recorded research base, generated-xmd.ts uses whole-source admission,
exact identity/form tables and GeneratedDataExpressions. Its
NO_GENERATED_CONTEXT rejects Output, Content and Return. Fragment expansion calls
expandSegmentsWithin rather than root body selection. Core's expandBody owns
ordinary Output sequencing and partial selected output. evaluation-profile.ts
captures protected component answers and revokes their execution lifetime.

REPL session submit acknowledges admission; join observes the exact held entry
and then waits for task teardown. entries.ts derives entry keys from admission
order and partitions each ordinary root import through its terminal close.
Those entry boundaries remain authoritative.

No production code, specification, GitHub issue or implementation acceptance is
changed by this proposal. The exact implementation base is refreshed after the
recorded #881 predecessor is delivered.
