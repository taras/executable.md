# Sidekick storage and recovery contract

Each REPL execution owns its entry history and Sidekick history. Reopening
projects both without running Sidekick. Explicit continuation uses the same
provider conversation and authors a fresh response, preserving earlier effects.

This contract derives storage mechanics from the Product Owner's accepted
paired-history, first-use, interruption and Submit-reconciliation decisions in
remaining-architecture.md. Private record schemas and adapters belong to CLI;
Core consumes its existing DurableStream through the accepted host interface.

## Locations and recognition

The existing contextual per-user REPL root remains the only storage root. For a
new-format execution, use `v1/<execution>/entries.jsonl` and
`v1/<execution>/sidekick.jsonl`. The opaque execution validator runs before path
construction. Existing `<execution>.jsonl` is the older single-file format.

The entry file contains exactly the ordinary serialized DurableEvents it holds
today. Its sequential root-import/close grammar, entry IDs and History markers
do not change. Chat or host metadata never enters that stream.

Sidekick history is an append-only, versioned JSON-lines protocol. Parse its
complete records, ownership, order and references before presenting it as a valid
history. Unknown versions, malformed records, missing final newlines, required
files that are missing/not regular files and conflicting ownership are explicit
refusals. Diagnostics identify the problem without echoing private record text.
No refusal truncates, overwrites or creates a replacement conversation.

The first owner record names the format version and execution, plus an optional
older-file origin. A ready record acknowledges initialization after both files
are established. A published new-format directory requires both records and
both files. An incomplete directory refuses rather than falling back to an older
file and creating a second history. A newer-format location does not become a
legacy execution because its Sidekick file disappeared.

If both formats exist, the old file is accepted only as the exact retained
origin of this published pair: its byte count and SHA-256 match the owner
record, and the copied initial entry prefix matches it. Later entry events may
follow that prefix in the new file. An unrelated or changed old file is a
conflict, not an alternate current writer. Older CLIs cannot continue a
new-format pair through the old file as a supported downgrade path.

## Initialize and upgrade before provider work

A new execution claims its entry file with the existing exclusive-create host
operation; only its successful creator creates Sidekick history. Establish the
owner and ready records before exposing the session. Initialization starts no
provider turn. Existing single-writer limits remain; this introduces no lease or
multi-process writer support.

Opening a valid older single-file execution performs no conversion, history
append or Sidekick provider call. The first explicit Sidekick message performs
the accepted upgrade, preserving its execution identity and valid route state.
It copies acknowledged entry bytes exactly and never executes them as migration.

The root serializes the write handoff. It holds new admissions and entry-journal
appends at the storage handoff boundary, waits for an in-flight append acknowledgement,
then copies and fingerprints the exact retained prefix. An already-running entry
keeps its task and segment view; it does not restart. All subsequent appends use
the new writer after publication, including appends from that same entry.

Write ready only after the copied entry history and Sidekick owner record are
acknowledged. Switch the live root writer before releasing the handoff, without
another suspension between acknowledging publication and selecting that writer.
No event can therefore append to the old path after the published prefix was
chosen. No provider work starts before the new pair is ready.

Failure before publication leaves the original entry file recoverable. A partial
new-format initialization is not a usable pair, and a later opening refuses
instead of guessing which files to repair. An uncertain append follows the
existing fatal journal-error contract. The old file is retained as an origin;
this feature deletes no original history. Copying, fingerprinting and writer
handoff are CLI-private operations under the root, not new user commands.

## Required retained records

The CLI's strict schemas retain these facts, using internal IDs for correlation.
Their exact private TypeScript names are delegated to the Planner; these
payloads, references and ordering constraints are required.

| Record family | Required facts and rules |
| --- | --- |
| Ownership/publication | Version, REPL execution, optional original byte count/hash and copied prefix, then ready acknowledgement. No provider or conversation effects before ready. |
| Conversation selection | Unique conversation ID, resolved agent name, preparation and successful activation, and prior association. A failed setup does not activate a replacement; old conversations remain retained. |
| Preferences/reference | Desired model/effort and exact bootstrap, guide index, compact canonical response surface and metadata/asset versions supplied to a particular conversation/turn. Full reference/chapter bodies are supplied only when read. Verified applied configuration comes from canonical provider readback/Prompt records. |
| Person input | Conversation, message/turn correlation and exact admitted message. Admission clears only that chat revision; newer unsent text remains process-local. |
| Canonical Core events | Conversation, owned sequence/segment and unchanged canonical DurableEvent. Its adapter exposes only that canonical stream to Core and acknowledges only after physical append. |
| Response outcome | Owning canonical completed turn, exact response/admission identity, successful root rendering or actual partial/error, and its hasOutput fact. Provider deltas alone do not constitute an admitted response. |
| Control intent/outcome | Conversation, response, operation occurrence/order, component, exact admitted arguments and observed outcome. Submit additionally binds the entry prefix, reserved entry ID and exact source. |
| Feedback delivery | The ordered operation facts and context sent to a particular canonical next turn. Delivery is evidenced by canonical turn identity/acceptance, not a local claim that text was sent. |

Host outcome data uses Effection Result and the repository's canonical serialized
Error/result conventions. Read snapshots retain the exact detached binding map
or entry-output chunk, target, range, observed length/status and selected limit.
They do not query current state to reconstruct an earlier result.

The discovery amendment uses these same record families: retain the exact
requested Guide.* chapter text and REPL.Environment snapshot as designated read
outcomes, then their canonical accepted feedback delivery. An index/version
record is not proof that every chapter was delivered. Cold recovery reads the
retained observation rather than fetching current chapter/environment content.

Elicit retains only validated answers; unsubmitted form fields stay process-local. Published
chat is derived from acknowledged response output rather than a second mutable
copy of provider history.

Owner IDs and schemas are composition data. They grant no engine claimant,
native session identity, admission permission or configuration authority.
Canonical Core/provider assertions still decide those matters.

## Conversation activation and continuation

### Message identity and turn association

A retained person message has an identity independent of the turn numbers
recorded by Core. Its message ID is not proof that a provider turn was recorded. The
acknowledged message or feedback record with turn:null begins the records for a
request; stop before the next initiating record in that conversation. A
saved agent_prompt outcome from Core among those records establishes the request's actual
turn identity. A missing outcome leaves the association unknown, including
after later requests complete. It does not establish that the message was
unsent or rejected.

Projection preserves message chronology and distinguishes local message
identity from a nullable turn association. Replies continue to belong to their
completed turns. Reference records use their owning message's association before
claiming delivery into a turn whose completion the saved records establish. No relationship is
inferred from equal ordinals or matching text outside the records for that request.

The accepted behavior and precise CLI-private read boundary are recorded in
[the message-correlation amendment](pr2-recovery-message-correlation-architect-decision.md).
Existing wire records remain unchanged; this adds no turn counter or Core API.

### Activation and explicit continuation

Create a distinct conversation ID on an explicit agent change. Open its scoped
Core owner with the accepted request and constrained provider assembly. Commit
activation only after that setup succeeds; setup failure preserves the previous
active selection and association. An established conversation never changes
agent/provider in place. Initial native association still follows the canonical
accepted-first-turn assertion order; logical setup is not proof of native
creation. A later terminal prompt failure pauses that selected conversation.

Retain canonical provider, resolved command, tagged native identity and session
configuration in the conversation's canonical account. Core saves the initial
configuration before native creation can begin; the native assertion is a
separate fact recorded in its existing acceptance order.
Missing/multiple/changed assertions refuse replacement. A
first-turn assertion before mapping acknowledgement is reconciled only to that
same identity. A provider-store key or old transcript cannot establish identity.
Creation establishes the initial settings, not immutable conversation
identity. A supported update applies and verifies the changed settings on that
same native conversation and retains the resulting effective configuration before new
work relies on it. An unsupported or unestablished change refuses without
replacement. This PR adds no live-update controls or protocol. Ownership,
lifecycle and exact interfaces are accepted in
[the configuration amendment](pr2-recovery-creation-policy-architect-decision.md)
and [Planner handoff](pr2-session-configuration-planner-handoff.md).
The installed provider declares actual construction inputs through
AgentSessionPlacement.activate; Core retains explicit ProviderSessionConfiguration
values and checks them before reattachment. Missing required configuration
refuses; cold projection performs no activation. Implementation remains pending.
Desired model/effort is applied and read back at the next prompt boundary;
compatible syntax-reference refresh is turn context, not a provider
configuration change or widened response ceiling.

Each canonical turn and response evaluation has its own owned durable sequence.
An interrupted old sequence remains an actual unfinished fact, not a prompt or
response suffix to replay automatically. Core's scoped conversation operation
continues genuine Session identity while new explicit work receives a fresh
turn sequence. It does not manufacture terminal/cancellation records to make an
old sequence appear complete.

Cold projection performs no appends or provider calls. On explicit continuation,
report acknowledged effects and interrupted work using the accepted simple
feedback format. A retained, completed result is not recomputed; an unknown
accepted-provider-turn status is canonically reconciled or refused. A local
feedback delivery marker is insufficient proof to resend into a native session.
No transport-level exactly-once promise is inferred from an append-only file.

## Submit intent and the entry journal

The root reserves the next entry slot before acknowledging a Submit intent.
The retained intent names the exact current journal prefix, rendered immutable
draft source, draft revision and reserved entry ID. This single admission gate
prevents any other submitter from taking that slot while the intent is unresolved.
Preflight and final root checks retain Live, revision, liveness, running-entry
and teardown guards. Stop/manual takeover before actual admission starts no entry.

After a crash, the same prefix with no reserved entry means not admitted. That
prefix followed by the exact reserved entry/source identifies the admitted entry.
A disagreement refuses guessing, content-only matching and repeated admission.
Reconcile before any new admission; retain its resolution on the next explicit
mutating action, never as a cold-open write. An unadmitted old intent is not
automatically submitted. An admitted entry follows ordinary recovery independently.

Entry outcomes and source remain authoritative in entries.jsonl. Its terminal
output does not prove in-process resource teardown; live completion feedback also
waits for that exact task's join. Stop cancels the Sidekick wait and does not
change the admitted entry's outcome. Exit cancels/joins the whole REPL owner.

## Evidence boundary

The accepted recovery and first-use journeys require interruption at publication,
provider establishment, Submit intent/admission and feedback acceptance boundaries.
The Planner derives finite integration cases using the real repository, writers,
Core/provider seams and fresh-process reconstruction. Test adapters control the
boundaries; a second test-only storage or Sidekick owner cannot prove the contract.
No implementation or test run is claimed by this architecture record.
