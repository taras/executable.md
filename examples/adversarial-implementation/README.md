# Adversarial implementation

Run implementation feedback from accepted work through one launch. Prepared scope facts select direct
implementation, ordinary planning followed by implementation, or a validated API
foundation followed by remaining consumer migration. Existing impact policy
selects internal feedback separately from that route. Delivery additionally requires
the recorded independent review and current CI.

## Applies to

Ordinary XMD runs and REPL entry programs. Each new work item has an isolated,
prepared source checkout, an exact clean source revision, a fresh artifact
directory outside that checkout, and three distinct original role sessions. One
role runs at a time. These components are a repository example; they do not
change a running role's model or a live workflow's include directory.

## Run a work item

Prepare this repository with `deno task setup`. Copy `task.example.json` to a
local file and replace its source, exact revision, output directory, accepted
request, selected evidence paths, role providers, correction budgets, delivery policy and unused session names. Prepare the selected
source through its own repository instructions. Its feedback commits use its
configured Git signing and verification. Run from that source checkout:

```bash
cd /absolute/path/to/prepared-source-worktree
xmd run --allow-absolute /absolute/path/to/workflow/examples/adversarial-implementation/run.md \
  --props-task /absolute/path/to/task.json \
  --include /absolute/path/to/workflow/examples/adversarial-implementation/components --raw
```

`run.md --props-task` is the normal launch for all three routes. Inspect its
complete CLI with `xmd run /absolute/path/to/workflow/examples/adversarial-implementation/run.md --help`.
The task has no mode, phase, full flag or initialization override. `phase.md`
and `continue.md` below serve separate assignments and existing records.

The workflow enters the prepared checkout and artifact directory through absolute
`Dir` paths. Enable `--allow-absolute` for these runs; the flag retains existing
read/write restrictions.

## Select role providers and budgets

The launch task requires `providers` for all three original roles and explicit
`maxCorrections`, `maxApiRepairs` and `maxResponseCorrections`. For ordinary Codex
work, select:

```json
{
  "providers": {"architect":"codex","planner":"codex","implementor":"codex"},
  "maxCorrections": 3,
  "maxApiRepairs": 3,
  "maxResponseCorrections": 0
}
```

Planner and Implementor can independently select `claude` instead. The fixed
profiles below determine model and effort; provider selection never substitutes
another provider when one refuses. Architect uses `codex`. Missing or invalid
allocation or budget fields hold before paid work. The resolved Ticket manifest
retains the selected providers and all three budgets through continuation.

`maxCorrections` bounds source corrections and `maxApiRepairs` bounds
consumer-driven API repairs, each from zero through ten. `maxResponseCorrections`
bounds extra response-format calls per completed assignment, from zero through
three. Zero admits no extra response call. It applies to ordinary planning,
implementation, selected feedback reviews, independent delivery reviews and
foundation replies, including
repairs by their original owner. It authorizes no transport retry or repetition
of uncertain productive work. Continuing a Ticket keeps its consumed source
correction count and recorded allocation; it does not restart a failed attempt.

## Prepare scope and impact

All four closed scope groups are required. Their evidence arrays name nonempty,
distinct references selected in `task.inputs`; existing accepted scope and
focused checks can support several groups. The launch captures those texts once,
including role guides from the selected source. Later owners receive the
captured accepted text and selected fresh plan references. Keep the combined
initial packet within 64000 characters; retain full logs as references.

| Scope group | Prepared fact |
| --- | --- |
| `decisions.evidence`, `decisions.openQuestions` | Accepted decisions and distinct unresolved material questions. Any question holds before roles. Empty questions declares settled decisions under existing approval rules. |
| `implementation.ready`, `implementation.evidence` | Whether accepted scope and focused checks suffice for direct implementation through existing interfaces. A separate plan document is optional. |
| `sharedApi.needed`, `sharedApi.evidence` | Whether accepted behavior requires shared API work. Necessary API work excludes simple; it alone does not justify a migration split. |
| `migration` | `null` declares no worthwhile separate migration split. A record requires `evidence`, `representativeConsumers` and `remainingConsumers`: repeated production friction, representative validation and substantial identified conversion remaining. Both consumer lists are nonempty, distinct, disjoint repository-relative committed production paths. No file-count threshold applies. |

`assessment` is the existing ReviewPolicy impact assessment, independent of
scope. Its evidence and optional risk evidence also select `inputs`. Routing
never selects reviewers, models or effort. Validation establishes shape and
supported consistency; the preparing agent and reviewers establish approval,
API necessity, production representativeness and migration effort.

The table is ordered. Missing or unknown facts never become false or null.

| Prepared input | Observable action |
| --- | --- |
| Missing/invalid/unknown member, unavailable evidence/source, occupied fresh-work directory, conflicting identities or contradictory migration record | Actionable hold before paid roles; identify what to correct or which existing record to continue |
| Any `decisions.openQuestions` item | Hold before paid roles; show the unanswered question and evidence |
| Valid non-null migration record and `sharedApi.needed=true` | Existing Planner foundation and representative validation, then remaining consumer implementation, selected review and retirement |
| `migration=null`, `sharedApi.needed=false`, `implementation.ready=true` | Direct Implementor, then existing impact-selected independent review |
| `migration=null`, `sharedApi.needed=false`, `implementation.ready=false` | Ordinary Planner plan/evidence, with original Architect discovery when requested, then the same Planner handoff to Implementor and selected review |
| `migration=null`, `sharedApi.needed=true`, either readiness value | Ordinary Planner plan/evidence, with original Architect discovery when requested, then the same Planner handoff to one Implementor for necessary API work and consumers, followed by selected review |

```text
Normal run.md launch
        |
        v
Valid facts, evidence, source and fresh-work prerequisites?
        | no ------------------------> HOLD: explain correction/continuation
        | yes
        v
Any unresolved material question?
        | yes -----------------------> HOLD: show question and evidence
        | no
        v
Justified migration record?  (requires sharedApi.needed=true)
        | yes -----------------------> MIGRATION
        |                              Planner foundation + representatives
        |                              -> foundation review
        |                              -> Implementor remaining consumers
        |                              -> impact-selected review -> retirement
        | no (migration=null)
        v
Shared API needed?
        | yes -----------------------> STANDARD
        |                              Planner plan/evidence
        |                              -> original Architect if discovery needed
        |                              -> same Planner -> Implementor
        |                              -> impact-selected review
        | no
        v
Implementation ready?
        | no ------------------------> STANDARD (same sequence above)
        | yes
        v
SIMPLE: Implementor -> impact-selected review
```

Whenever launch assessment semantics, routing conditions, branch precedence or
initial role sequence change, update the executable gate, decision table and
flow diagram in the same PR; update affected focused routing tests. Reviewers
verify their correspondence. A diagram-only edit does not alter accepted policy.
Use existing routing tests and review; no separate diagram tooling or model call
is needed.

A ready existing-interface fix runs simple. A complex bug with settled behavior
but an unready implementation runs standard. Necessary API work with
`migration=null` also stays standard: Planner supplies plan/evidence, and one
Implementor owns the API and consumers. Migration validates its foundation
before handing over the remainder. A bug label, API edit, caller count or diff
size does not select a route. A later material question holds under the existing
phase contract; ordinary planning does not decide it.

An initial refusal returns `status=hold`, an actionable reason and empty history,
with no fabricated phase call or checkpoint. Simple and standard return a small Ticket envelope; migration returns its bounded
Adversarial disposition and Ticket reference.
Provider and persistence failures retain their existing handling. Preserve first
failure output and partial effects before another attempt.

The ordinary Ticket starts before the first Planner call. A validated
`needs_discovery` request reaches the original Architect and returns its answer
to the same Planner. Only that Planner's complete handoff starts implementation.
The initial journey runs at most those three discovery calls. Another discovery
request saves a dispatchable paused checkpoint and returns its confirmed
continuation descriptor and next gate. Save the small returned envelope and advance it with `continue.md
--props-record /absolute/path/to/ticket-record.json --props-steps 1`.
Planning and discovery must leave source clean at the exact launch revision,
including when a reply is rejected or absent. They require no signed feedback
commit. Routing consumes and resets none of the three correction allowances.

An occupied fresh-work directory holds; it is never an implicit retry or
continuation. An ordinary command's diagnostic journal is not a continuation
checkpoint. Reconcile its saved calls and partial effects before new work. In a
retained REPL, reopen the original unfinished entry under its selected source
and include version. Keep the original session identities and recorded inputs.

The roles use the normal agent permission policy. Running this example invokes
paid coding agents and permits the assigned implementation work. Publication,
issue/PR metadata and delivery remain with the Sidekick running Codex.

## Keep the original conversation

Every production role passes through `Phase.Session` inside its resolved Session,
before its Prompt. The first call records the agent, logical name, resolved
session key, cwd and exact public `Session.identity` kind/value pair under the work's `sessions`
directory. It records prompt subscription attempts separately from the first
actual started event. An attempted call with no confirmed identity holds for
reconciliation even if later resolution offers an identity. A verified placement
that was never prompted remains distinct from an uncertain attempted call.
Fresh placements that acquire their confirmed identity during the turn
retain it when that turn unwinds. Subsequent calls compare the resolved identity
by both kind and value before expanding the prompt. An ACP loading target stays
distinct from a native identity. A mismatch preserves the original receipt and saves
the observed mismatch; it sends no prompt and grants no retry or fallback.
Session resolution retains its existing provider setup behavior.

This candidate writes `phase-session.v2` receipts. Older receipts refuse without
changes; they are not migrated. Existing tickets keep their pinned workflow and
original receipts.

Ordinary Tickets and API foundation/migration work share their original identity
directory across attempts. For standalone `phase.md` requests, retain
`assignment.identityDirectory` and set `assignment.sessionEstablished=true` on
continuations. An established continuation with a missing receipt holds; recover
the original evidence rather than treating it as a fresh call. Adopting a runtime
or adapter never proves conversation continuity from a logical session name alone.
Independent review uses `delivery.directory/sessions` and requires a reviewer's
retained identity when that same reviewer has an earlier attempt that may have
entered its session. An attempt whose catalog offered no selectable model, or
whose session could not be established, does not count. An Astra replacement
keeps a conversation and receipt of its own, so a Fable attempt never makes it a
continuation. An explicitly prepared continuation
can likewise require the original receipt with `delivery.sessionEstablished=true`.

## Select typing evidence and record amendments

When a shared type, required property or exported interface changes, planning
identifies its typing consumers, declarations and test fixtures as well as
runtime callers. Include the applicable Deno and Node typecheck in the focused
evidence for affected shared shapes. Runtime affected-test selection follows
imports and does not establish that every typing consumer still compiles.
Include real cross-runtime child-execution witnesses when fixture filenames, module boundaries or loader behavior change; typing alone cannot show which module mode a child selects. This does not require full runtime suites for ordinary changes.

Record user-directed amendments separately from implementation defects in plans,
handoffs and cost reports, with their accepted scope and approval evidence.
Both retain the existing correction allowances. Classification grants no extra
call, resets no counter and does not turn an amendment into a defect metric.

## Complete delivery from recorded requirements

Use this after implementation feedback, for ordinary runs and REPL entries.
`feedback_ready` establishes the selected internal feedback; it leaves independent
review, required CI and current main health outstanding. `run.md` requires a
`delivery` declaration before any role starts and writes its original captured
acceptance text to `delivery/requirements.json`. A missing declaration refuses
launch. Clause IDs are distinct and each source selects an original `task.inputs`
reference. The independent reviewer uses a separate conversation from all three
implementation roles.

Publish the branch and draft PR through the existing owner, then run from the
same source checkout:

```bash
xmd run --allow-absolute /absolute/path/to/workflow/examples/adversarial-implementation/delivery.md \
  --props-record /absolute/work/fresh-bounded-parser-fix/delivery/requirements.json \
  --props-number 123 --props-action status \
  --include /absolute/path/to/workflow/examples/adversarial-implementation/components --raw
```

`status` starts no model. It reads the saved joined review, the current PR and
GitHub's CI workflow runs. Its `nextAction` is computed from the same facts as
its `status` and `remaining` fields. When it requests `review`, select
`--props-action review` on that command to perform the independent review with
the provider, model, effort and session recorded at launch. The review uses
normal coding-agent permissions in a provider scope of its own. It receives the
original captured acceptance text and may inspect source and run focused checks;
it receives no implementation, delegation, posting or merge task.

A Fable reviewer (`claude` with model `fable` or `claude-fable-*`) has one
standing replacement: Codex `gpt-6-astra` with the same effort, in the
conversation named by the reviewer's session plus `-astra`. The review action
writes `review-<sha>/selection.json` before any reviewer starts, binding the
revision, policy, captured inputs, response schema and both identities. Fable is
selected from the agent's advertised catalog, preferring its `fable` alias, so a
catalog that offers neither sends no paid prompt. Astra starts only after Fable
proved unavailable, was refused before its turn, failed without review output, or
failed saying nothing but its exact usage-limit notice under the matching provider
runtime diagnostic,
*and* its provider scope closed normally. Its records go to
`review-<sha>/replacement/`, after `transition.json` names the Fable evidence it
replaces; Fable's own files are never rewritten. A pass, a finding or a blocked
review from Fable is final: findings go to the normal repair path, never to
another reviewer. A policy that already names Astra is the final reviewer, and
any other reviewer remains the only one.

Each attempt runs inside `<Try>`: its provider scope is released before Catch or
the next step runs, and `execution.json` records that release. A release that
fails ends the run, leaving the attempt reserved for reconciliation without a
replacement or a hold. When no eligible reviewer produced a review, or the first
attempt cannot be replaced (it streamed partial output, the provider reported the
turn cancelled, or it failed outside the
provider), the action writes `review-<sha>/hold.json` and then asks through
`<Elicit>` with the actual identities and reasons. The answer is `hold` or
`reconcile`, retained in `disposition.json` before it acts: `hold` leaves
delivery waiting, and `reconcile` reads the existing evidence once. Neither
starts a reviewer, waives the review or changes an allowance. A cancelled or
failed question leaves the hold unanswered, and the next `review` action asks the
same question again without sending a reviewer; an answered hold is never asked
again. `status`, `closeout` and `reconcile` ask nothing and start no reviewer.

```text
feedback pending -> continue original feedback
feedback ready   -> independent review pending -> joined exact-commit verdict
                      | Fable unavailable/refused  -> one Astra review (review)
                      | no reviewer completed      -> review_held: answer via review
                      | incomplete/uncertain       -> reconcile original call
                      | blocking finding           -> request approved repair
                      | pass + required CI + main   -> finish PR metadata
                      | all passed + PR ready       -> await authorized merge
                      | confirmed merge             -> delivered
```

Independent review summaries allow 1500 characters; detailed observations belong
in `findings`. The request states this bound alongside the exact revision and
clause IDs. Ordinary phase and API-foundation summaries retain their own bounds.

A joined reply containing only `{"status":"in_progress"}` gets one completion
turn in the same native conversation, with the same reviewer, resolved model,
effort and exact source revision. The workflow saves the original reply, checks
that the checkout is clean and reserves `completion/` before sending a prompt
with a five-minute deadline. A second progress reply, unavailable conversation,
failed turn or changed source holds the review. Unmarked prose and malformed
verdicts do not authorize a completion turn. Status and reconciliation read the
saved evidence without prompting; a later invocation never starts an unused or
interrupted completion turn.

The completion turn has its own allowance. If it returns a review whose only
defect is summary length, the original formatting allowance still applies.

An otherwise-valid joined review with only an oversized summary can consume the
work item's recorded `maxResponseCorrections` allowance. Each correction stays
in the selected reviewer conversation with the same resolved model and effort.
It shortens only `summary`; every other result field is frozen. Zero permits no
extra call. The workflow records the original raw reply and rejection, reserves
each correction before dispatch, and saves its request, native outcome, reply,
source observations and disposition separately. Exhaustion, changed substance,
changed source or uncertain work holds explicitly; none selects a fallback
reviewer or repeats the completed review. Reconciliation validates this saved
chain without prompting. Historical assignments without a recorded allowance
have zero; a new workflow does not retroactively accept their rejected replies.


Use `--props-action reconcile` when the selected joined review has a saved
execution but no accepted receipt. Only the selection's attempt qualifies: the
original reviewer, or Astra after a retained transition from an eligible Fable
failure. It checks that attempt's assignment, joined execution, unchanged raw
reply, any saved completion, current schema, clauses and source before creating the missing receipt,
and saves a raw reply the execution joined but never wrote. It never shortens text, changes a verdict, repeats
a model call or overwrites a contradictory receipt. Missing or uncertain execution
continues to hold. Status uses this same validation boundary to read receipts.

Reconciliation is limited to independent review from a work item launched under
the same response contract. Its assignment retains the exact response schema; a
missing or different schema refuses rather than reinterpreting an old reply. It validates only corrections recorded under the original review assignment.
It cannot adopt an ordinary rejected role verdict, rewrite its raw rejection or partial work, or reset a correction budget.
A current schema accepting older text does not retroactively approve that work.
Preserve the original rejection and require an explicit applicable
schema-amendment decision, recording the old bound, amended bound, exact raw
reply and source revision before any historical acceptance. This example's
new-ticket pilot imports no historical review attempts; historical adoption is
held for explicit reconciliation rather than automatic schema migration.

Use `--props-action closeout` to write `delivery/closeout.json` and
`delivery/closeout.md` from the actual `Delivery.Status` result. The JSON retains
the full status and evidence; the report names the revision, gates, review,
findings and next action. Incomplete gates remain visible. This action starts no
model, publishes nothing and grants no merge permission.

A complete review covers every recorded clause and has no blocking finding.
The component writes its completion receipt after the role operation has returned
and its scope has unwound. Status compares that receipt with the actual saved
execution reply, reviewer configuration and acceptance clauses. A matching JSON
summary alone supplies none of this correspondence. An occupied attempt is held
for reconciliation, including a failure before a result or receipt exists; a
second invocation never repeats that model call automatically. A new source
commit requires matching implementation feedback and independent review. A
repair keeps the original conversations and its separately approved correction
allowance; this entry grants no repair round.

The PR must name the checkout's exact current commit and branch with base main.
Readback checks the PR and main heads again after the remote reads, and checks
the checkout again. CI selection follows the highest run number and attempt for
the requested PR, its exact head commit and head branch, and requires that attempt's
actual `green` job to succeed. Missing PR association supplies no passing evidence.
Main health reuses the repository's authoritative selection
rule for a push to main's exact current head. Pending, cancelled, skipped and
failed runs cannot pass. The maintainer-applied `ci-main-red-fix` exception keeps
the repository's CI contract: it substitutes composability for the main lookup
inside CI. A draft PR remains `publication_pending`; only a confirmed merge with
a merge commit reports `delivered`. Refresh status before acting on readiness.

The saved `status.json` is the last observation, not a second execution state.
Use the command for a current answer. Local records are trusted workflow
artifacts, not signatures or remotely verifiable attestations. GitHub does not
read them, and this gate does not prevent an arbitrary chat message or a person
from claiming readiness or merging independently.

## Prepare requests without metadata repair turns

Claude workflow-role calls use the CLI's scoped `claude-workflow-role` provider.
Each role installs it directly around its authored session, covering initial and
continued prompts. It disables native shell/subagent backgrounding and denies
`ScheduleWakeup` and `Monitor`;
ordinary interactive Sidekick calls keep their defaults. A retained session that
lacks matching creation settings refuses before another prompt. Each role joins
its owned processes and returns its result in the same call. The upfront brief
contains work, evidence and lifetime rules. Identical role instructions selected
as input are delivered once; a different captured version retains the current
role brief too. The frozen submission guide contains response schema, limits and
routing. Reading defaults to result preparation; an earlier read must resolve a
concrete reporting requirement that blocks a work decision. Every result,
including an early blocker, requires the complete guide within the same call.

These rules apply to separate phase requests and Ticket role calls. Codex authors
prose committed to workflow documents, including guides, component instructions
and prompt templates. Claude roles may write internal runtime handoffs, hold
prompts and summaries.
`Phase.Run` freezes the submission guide in its reserved attempt directory.
`Phase.Request` checks that guide and prepares the phase prompt before entering
an Agent. The prompt includes initial repository and role instructions,
the assignment, selected text and an absolute reference to `submission-guide.md`
in the attempt directory. The guide contains the complete submission instructions
and the current role- and phase-specific JSON contract. Read it before returning
any result, including an early blocker, source conflict or unanswered decision.
The same retained native call reads the file and returns the result; staging the
guide adds no model call.

The guide and its hash receipt are runner-owned. Preparation refuses occupied
paths and confirms that the published text is readable under current File
permissions and protection. After saving each raw reply, the workflow verifies
the guide and receipt against the expected submission instructions before it
accepts a result or starts a correction. Missing, unreadable or changed files
hold the attempt with its raw reply preserved. Corrections retain their existing
inline repair packet, original session and allowance.

A missing selected component or input fails before provider dispatch. A prompt
above 256000 characters refuses without truncation. The guide has its own
256000-character and UTF-8-byte bounds. Selected evidence keeps its separate
64000-character allowance; moving submission instructions does not enlarge it.
Provider configuration and client compatibility retain their existing checks before a turn starts.
No paid prompt probes installation or repairs launch metadata.

`Phase.Response` supplies omitted phase and work from the assignment, and the
assigned revision for a read-only phase. It supplies the accepted continuation
for complete/pass. Explicit conflicting fields remain errors. The Implementor
still supplies its actual resulting commit, and every role supplies its real
verdict, findings and evidence. The existing zero-response-correction option
continues to validate and retain a reply at zero; missing substantive facts are
never synthesized to make a reply pass. `discoveryRequests[].role` and
`discoveryGaps[].request.role` name the invoked reporting actor. A Planner
requesting Architect discovery still names `planner` as author; `next.role`
names `architect` as successor. Explicit contradictory authors are rejected.
The raw reply, rejection and disposition remain inspectable without becoming a
canonical result.

Acceptance clauses preserve their original source and wording through delivery.
A reviewer reports a material ambiguity as blocked instead of strengthening a
criterion. This records traceability; it does not mechanically decide whether two
natural-language requirements mean the same thing.

Submission-owned progress and joined entry completion remain separate work in
[#1062](https://github.com/taras/executable.md/issues/1062). Fatal entry outcome
diagnostics remain [#1059](https://github.com/taras/executable.md/issues/1059).
Neither is replaced by the delivery status file or an attachment observer.

## Run a separate phase or continue a saved ticket

Use these entries from the workflow repository when coordinating a separate
review or advancing an existing ticket. They apply to ordinary commands; a
running REPL can invoke the same `Phase.Run` and `Ticket.Continue` components.
Keep the CLI and include directory on the selected workflow version. The
assignment's `repository` selects the source checkout independently.

For a separate phase, save one request file using the existing phase assignment:

```json
{
  "role": "planner",
  "session": "original-planner-session",
  "attempt": "/absolute/path/to/work/review-1",
  "initialize": false,
  "maxResponseCorrections": 0,
  "inputPaths": ["/absolute/path/to/review-guide.md"],
  "assignment": {
    "phase": "review",
    "work": "selected-task",
    "repository": "/absolute/path/to/source",
    "revision": "1111111111111111111111111111111111111111",
    "priorRevision": null,
    "request": "Review the committed change against the supplied guide.",
    "changedPaths": [],
    "artifacts": [],
    "evidence": [],
    "findings": [],
    "assessment": {
      "mechanical": false,
      "architecture": false,
      "acceptance": true,
      "risk": null,
      "reason": "Review the changed behavior and its evidence.",
      "evidence": ["/absolute/path/to/review-guide.md"]
    },
    "continuation": {"phase": "ready", "role": null}
  }
}
```

Replace the paths, session and revision with the recorded values. The attempt
must be unused. `inputPaths` and the assignment's `handoffInputs` select text
files whose contents enter this prompt; artifacts remain references. A retained
session uses `initialize: false`. Set it to true only for the role's first call.

```bash
deno task xmd run --allow-absolute examples/adversarial-implementation/phase.md \
  --props-request /absolute/path/to/request.json \
  --include examples/adversarial-implementation/components --raw
```

The command returns status, revision and the saved canonical result path.
`Phase.Run` saves its assignment,
raw reply, result, status and acceptance receipt beneath the request's attempt.
Source and role checks run before a prompt. Reusing an occupied attempt refuses;
inspect its saved effects before selecting another attempt.

Set `maxResponseCorrections` to zero to validate the reply without another model
prompt. A valid reply saves its canonical result. A rejected reply saves
the raw text, rejection and `response-disposition.json`, then fails without a
canonical result or successor. Inspect those records before continuing; zero
does not skip validation or retry an uncertain prompt. This limit controls
response-format corrections, independently of implementation corrections and
transport retries. It accepts zero through three and defaults to three when
omitted. A direct REPL invocation uses the same option:

```xmd
<Phase.Run phase={request.assignment.phase} role={request.role}
  session={request.session} assignment={request.assignment} attempt={request.attempt}
  initialize={request.initialize ?? false} inputs={Object.values(documents)}
  plannerProvider={request.plannerProvider ?? "claude"}
  implementationProvider={request.implementationProvider ?? "claude"}
  maxResponseCorrections={0} successor={request.assignment.continuation.phase}
  nextRole={request.assignment.continuation.role} as="phase" />
```

Here `request` is the prepared phase request above and `documents` is the
selected input map produced by `<Ticket.Selected>` from `<Ticket.Documents>` metadata. Keep the original session
and reserved attempts when changing this limit at a completed phase boundary.

To advance a saved ordinary `run.md`, `Ticket.Run` or `Ticket.Continue` return,
pass its complete small envelope:

```bash
deno task xmd run --allow-absolute examples/adversarial-implementation/continue.md \
  --props-record /absolute/path/to/ticket-record.json --props-steps 1 \
  --include examples/adversarial-implementation/components --raw
```

The envelope names a confirmed continuation by path, UTF-8 byte length and SHA-256.
The protected continuation retains the original manifest, sessions, call ordinals,
delivered-input accounting and correction counts. Each explicit step runs at most
one role and joins settlement and publication before the next step. A paused
checkpoint names its next gate; held and completed tickets dispatch no role.
Save each returned envelope under a new filename rather than redirecting over its
input. A held publication preserves the previous confirmed descriptor and pending
canonical/execution receipt paths. Even an existing matching file cannot confirm
an uncertain write; preserve it for operator disposition without rewriting or
repeating completed work.

After the original host entry has joined, inspect its saved return without
advancing the ticket:

```bash
deno task xmd run --allow-absolute examples/adversarial-implementation/return.md \
  --props-record /absolute/path/to/ticket-record.json \
  --include examples/adversarial-implementation/components --raw
```

This entry validates saved control metadata and its exact length/hash through
current File permissions and enabled protection. It reads no unselected artifact
body and invokes no role, source command, signature check or test. Canonical role
completion, confirmed continuation publication and the host's joined outer
outcome remain separate facts. A failed outer return does not undo a completed
role or authorize a replay.

Artifact references retain the first successfully accepted permitted File text,
including unselected references. This observation intentionally differs from
configured `cat` stdout preprocessing. Literal reference reuse restores its
snapshot after the original changes or disappears; use a fresh reference for new
evidence. Equal text at distinct references keeps distinct provenance. Selected
hydration checks current permissions, protection and exact UTF-8 length/hash;
missing or changed snapshots hold without consulting the original file. Snapshot
and original receipt retention lasts through ticket completion. Calls carry
metadata and receipt paths, not cached input, result or observation bodies.

The native-host example bounds all outward representations together to 65,536
UTF-8 bytes, complete continuation metadata to 1,048,576 bytes, and each exact
text to 8,388,608 bytes, inclusively. JSON escaping, output and root duplicates
count toward these bounds. The selected prompt allowance remains separately
64,000 UTF-16 characters. Capacity saturation holds before another dispatch,
retaining the prior confirmed state and canonical work; it truncates or evicts
nothing. These guarantees cover the ordinary native File provider, with its
existing permission, containment and stable-namespace limits. They establish no
custom/workflow provider storage contract or migration of old inline records.

External reviewer models and publication use their existing workflows. The
phase entry retains the implementation workflow's role and model policy.

### Resolve a decision hold

A Planner or Architect that returns `needs_decision`, and an Implementor that
returns `needs_discovery` naming the Architect, hold the ticket for an accepted
decision. When the hold is at the clean launch revision before implementation
feedback, its envelope names the supported operation:

```json
{"entry": "resolve-decision.md", "gate": "planning", "action": "resolve_decision",
 "result": "/absolute/path/to/work/attempts/0000/result.json", "input": "ticket-decision.v1"}
```

Save the decision and its provenance as text files, then save one request that
binds them to this exact hold. Every field is required and no other field is
accepted:

```json
{
  "schema": "ticket-decision.v1",
  "work": "selected-task",
  "continuation": {"path": "/absolute/path/to/work/continuations/HASH.json", "utf8Bytes": 13240, "sha256": "HASH"},
  "heldResult": {"path": "/absolute/path/to/work/attempts/0000/result.json", "utf8Bytes": 2210, "sha256": "RESULT_HASH"},
  "disposition": "accept",
  "decision": {"path": "/absolute/path/to/decision.md", "utf8Bytes": 412, "sha256": "DECISION_HASH"},
  "provenance": {"path": "/absolute/path/to/provenance.md", "utf8Bytes": 96, "sha256": "PROVENANCE_HASH"},
  "acceptedInputs": []
}
```

`continuation` copies the held envelope's descriptor and `heldResult` the
retained descriptor of its final call's result. Each artifact descriptor names an
absolute path and its exact UTF-8 byte length and SHA-256. The decision and
provenance are always selected for the routed owner, followed by
`acceptedInputs` in order. A recorded reference keeps its first text; give changed
text a fresh path. Provenance states the actual authority, such as standing
coordinator authority. It is evidence for the routed owner; it neither overrides
a permission nor records a new human answer.

```bash
deno task xmd run --allow-absolute examples/adversarial-implementation/resolve-decision.md \
  --props-record /absolute/path/to/held-record.json \
  --props-decision /absolute/path/to/decision.json \
  --include examples/adversarial-implementation/components --raw
```

Resolution calls no role. It validates the held result, records the decision under
the hold's continuation digest, prepares the original owner and publishes the
successor. Continue the returned envelope with `continue.md --props-steps 1`; that
ordinary step dispatches the owner through the existing source, identity, input
and publication checks:

| Held result | Disposition | Next owner | Then |
| --- | --- | --- | --- |
| discovery Planner `needs_decision` | `accept` | original Planner | original Implementor |
| discovery Planner `needs_decision` | `amend` | original Architect | retained Planner, then original Implementor |
| discovery Architect `needs_decision` | `accept` | same Architect | retained Planner, then original Implementor |
| implementation Implementor `needs_discovery` naming the Architect | either | original Architect | retained Planner, then original Implementor |

The original task, sessions, calls, results, delivered inputs, source anchor and
correction count are unchanged; resolution grants no further corrections. Every
other hold refuses, including an Architect amendment, an API conflict routed to
the Planner, execution failure, uncertain native work, changed input, source
mismatch, an exhausted correction bound and publication failure. A held result
whose phase execution failed after the result was saved also refuses; resolution
requires the call's execution record to show completion. A dirty or moved
checkout, prior implementation feedback, a stale or foreign binding and a changed
input also refuse. A refusal returns a held envelope carrying the failure and
leaves the managed ticket unchanged; keep the original envelope.

Repeating the same request against the same hold returns its recorded successor
without publishing again. The repeat checks the evidence the successor retained,
under current File permission and protection; it does not reread the decision's
original files, so they may later change or disappear. A different decision for a resolved hold refuses. If
reservation, publication or the receipt is interrupted, the hold stays held and
its reservation directory preserves the first failure for operator disposition. A
matching successor file alone does not confirm the interrupted write. Repeated
continuation of an older envelope reuses the existing call reservation and resends
no role effect.

## Supervise a live REPL phase

Keep the original ACP call pending, or reconnect passively with the existing
exact-message `--follow` command. [Supervision](supervision.md) explains progress
rendering with `<Query>`, completion evidence and safe detachment. Follow waits
for an exchange; the selected entry and canonical phase or Ticket result still
determine the work's outcome.

## Responsibilities and models

| Owner | Work | Model and effort |
| --- | --- | --- |
| Planner | Ordinary plan/evidence; on migration, implement the API, validate representative consumers and repair API conflicts | Selected Codex `gpt-6.1-sol` or Claude `opus`; ordinary planning uses medium, high for a concrete recorded risk; migration foundation design uses high |
| Implementor | Implement accepted work; on migration, challenge the API, convert consumers and delete obsolete machinery | Selected Codex `gpt-6.1-sol`, medium (high for a concrete recorded risk), or Claude `opus`, high |
| Planner reviewer | Inspect the migration against the accepted outcome and evidence | Same selected provider and original Planner session, medium; high for a concrete recorded risk |
| Architect | Answer a concrete structural question or review structural impact | Codex `gpt-6.1-sol`, medium; high for a concrete recorded risk |
| Sidekick running Codex | Author and apply issue/PR titles and descriptions; own publication and delivery | Existing coordinating Sidekick |

Aliases select the provider's available Opus model. Coding roles
do not draft or edit issue/PR titles or descriptions. The phase runner
refuses editorial assignments; technical handoffs and API documentation remain
part of the roles' work.

Architect is conditional: reserving its conversation name starts no discovery
call. An ordinary Planner returns `needs_discovery` with its concrete structural
question; the foundation route retains its `needs_architect` handoff. An
implemented change's impact selects architecture review. Existing repository
rules still govern material product decisions and architectural choices.
When the API foundation has structural impact, Architect reviews that committed
foundation before migration starts. A non-passing verdict holds with its saved
request for the Sidekick to resolve; migration cannot hide the foundation's diff.

## The migration API handoff

The Planner returns a signed commit, an API guide, API-owned file paths and at
least two named behavioral examples. The guide describes purpose, the task the
API is optimized for, friction removed, necessary friction retained and expected
maintenance. Representative consumers exercise the real supported path; a
typecheck or a mock-only sketch is insufficient.

The migration owner verifies actual clean HEAD, ancestry and signature, confirms the
initial foundation changes an API-owned path, reads the committed consumer
files, and runs each example command. It saves the command's full result before
deciding whether migration can start. A failed example holds with its first
output and starts no migration role. The source and HEAD must remain unchanged
by validation.

`api.migration` names the remaining work, literal repository-relative paths to
retire and observable acceptance. Completion checks those paths are absent,
including symlinks. Passing reviews do not waive this outcome.

This workflow executes trusted role-supplied commands in the selected checkout.
It is not a sandbox for untrusted commands. Shape validation and green tests do
not prove that examples cover the right behavior; the roles and independent
review remain responsible for that judgment.

## Migration challenges, repair and review

Captured replies pass through the workflow's existing `<Phase.Extract>` and
`<SafeParse>` for schema validation.
Before phase validation, shortened hexadecimal source and evidence revisions
expand only when they identify one commit in the assigned repository. Missing,
ambiguous and non-commit references hold without a correction prompt. The raw
reply stays saved; `response-acceptance.json` records the expansions. Other
evidence fields remain subject to the existing correspondence checks.
One narrated or fenced JSON result is accepted without another agent call.
Multiple candidates, incomplete JSON and unclosed fences hold with the original
reply and diagnostics. Schema matching never chooses between candidates.

When the only invalid fields are an oversized summary or handoff, foundation
response correction can shorten those fields in the same Planner session, at
most `task.maxResponseCorrections` times. Every other field is frozen, including the API, source,
assessment and evidence. Each correction saves its request, raw reply and
disposition, and checks that source remains at the same clean commit. The
productive assignment is not repeated. An ambiguous or substantively invalid
reply has no established result to repair and holds without another prompt.

The Implementor keeps passing work in a focused commit and saves a failed API
witness outside the source checkout. It returns `needs_discovery` with
`apiConflict: { expected, observed, reproducer, artifact }`, failed command
evidence and a handoff to Planner. The workflow routes that exception back to
the original Planner and resumes the original Implementor after validation.
Other discovery conflicts retain their existing Architect/decision hold.

An ordinary migration cannot complete after changing an API-owned file. That
change goes through Planner's validated foundation. A dirty partial checkout,
provider failure, malformed response, unanswered decision or exhausted bound
holds with saved evidence. It does not trigger an uncertain prompt retry.

`maxApiRepairs` bounds consumer-driven API repairs; `maxCorrections` bounds the
existing implementation-review corrections. Both are explicit launch inputs and
accept zero through ten. Repeated redesign is evidence that the split is not paying
for itself: inspect the saved consumer conflicts before extending either bound.

The imported feedback loop retains impact-selected reviews, bounded response
format repair and exact-patch conditional corrections. A known exact correction
can close after its authorized patch and checks match; ordinary corrections go
only to affected responsibilities. `feedback_ready` is neither CI completion
nor permission to merge. The Sidekick running Codex handles metadata and the
repository's normal delivery gates afterwards.

Give existing external independent-review assignments the
[Reviewer guide](../../.agents/reviewer.md). It focuses on correctness,
minimalism, and performance when UI or performance-sensitive paths are affected,
including whether existing APIs suffice. Mechanical validation and review
bookkeeping stay with their existing workflow or coordinator owners. This guide
adds no workflow phase or review stage.

Start required Fable reviews when the exact feedback commit and focused evidence
are ready, without waiting for CI on `main` or the reviewed branch. When Fable
is unavailable, including exhausted Claude quota, use an independent Codex Astra
(`gpt-6-astra`) reviewer under the same scope, effort policy and correction
limits. Reconcile any in-flight call and preserve its findings before fallback.
Select Fable from the host provider's advertised model catalog, using its
`fable` alias when available. Record the exact provider and resolved model for
each review. A model name refused before the prompt is a configuration failure:
preserve the refusal and confirm that no prompt was sent before selecting an
advertised model. Keep automatic retries disabled. `delivery.md` applies this
order itself, as [above](#complete-delivery-from-recorded-requirements), and its
closeout names each attempt's provider, requested and configured model, effort,
conversation and evidence.

The repository's [review rules](../../AGENTS.md#feedback-commits) retain main
health and required CI as merge gates; review acceptance waives neither.

## Test without paid agents

```bash
deno task test examples/adversarial-implementation/tests/*.test.md
```

The launcher runs each Markdown suite through `xmd test` and enables absolute
host paths for its temporary checkouts and artifacts through a test plugin.

Only the role boundaries are replaced. These journeys use real signed scratch
Git repositories, committed shell consumers, focused command failures, the
production Markdown routing and the existing feedback verifier. The fake role
boundaries launch no model and publish nothing. Put them first only for tests.
The runtime test launcher runs the Markdown suite under each runtime and uses
the Deno CLI for its nested Git workflow, where the ordinary Git provider is
installed.

## Provenance and adoption

`components/Phase`, `Ticket`, `Discovery.Schema`, `ReviewPolicy`,
`ExactCorrection` and `Guide.ExactCorrection` package the existing local feedback
workflow. The normal launch composes those owners from prepared scope while retaining
validated foundations, role profiles, API-conflict repair, retirement and Codex
editorial ownership. Publication
automation, task-specific attachment/routing programs and historical trial
artifacts are outside this example.

Adopt the version at a completed checkpoint. Keep the old execution's journal
and evidence, use the new example's include directory for the new work item,
and refresh its accepted inputs against the actual source revision. Do not
replace a running role's conversation or reinterpret an old result as this
version's API handoff.

## Compare delivery outcomes

For the next six comparable bounded changes after adoption, use existing receipts
to record the route, accepted starting scope, start/delivery times, role calls,
human decisions, correction cycles and defects found after acceptance. Separate
implementation, review, CI, dependency and human-wait time. Keep unavailable
timings, token counts and costs null; record scope changes. Observed differences
establish no causal speed claim. This uses ordinary work and creates no paid
benchmark or recurring automation.

## Common mistake

Do not accept shorter selected examples while the promised fixture or legacy
adapter remains. Do not ask the Implementor to validate a paper API by designing it from
scratch. The first handoff contains working consumer code and passing evidence;
the final handoff contains the finished retirement and review evidence.

## Read next

Read [Planner](../../.agents/planner.md) and
[Implementor](../../.agents/implementor.md) for role assignments.
Read `<Adversarial.Schema />` for the API handoff shape and `<ReviewPolicy />`
for impact-based review selection.

## Prepare the next handoff

`<Ticket.Prepare record={record} call={call} as="prepared" />` checks the exact
recipient selected by Gate before its productive call starts. Inputs counts the
undelivered accepted inputs, that role's guide and explicitly selected handoff
files once each. Its 64,000 UTF-16-unit limit is separate from the complete
phase prompt's 256,000-character ceiling. A recorded delivery for the current
session takes precedence over the manifest's earlier delivery list.

A fitting packet keeps its paths, order and captured text and starts no analysis
prompt. Preparation saves its inventory, hashes and remaining allowance under
`preparations/<call.id>/receipt.json`. `original.json` names the retained snapshot
of every oversize original. Captured windows and a reduced candidate are retained
as protected snapshot text; the candidate uses a fresh path and links to that
receipt. Saved documents and call inputs carry only those snapshot descriptors. The original
Planner prepares exact extracts and supporting references, then compares the
candidate with the originals. The comparison is a recorded semantic judgment;
hashes establish text identity, not completeness of requirement extraction.

Preparation permits one reduction prompt, one comparison prompt and no correction
prompt. Captured windows contain at most 8,000 UTF-16 units without splitting a
surrogate pair. Every acquisition is recorded, including repeated original
windows in comparison; each prompt admits at most 64,000 selected units and
128,000 acquired material units. These measurements describe workflow acquisition,
not a sandbox on the native agent's tools. A mandatory floor above the limit,
missing original Planner evidence, remaining excess or uncertain preservation
holds before the successor. Continuing a held record replenishes no allowance.

Step, foundation, direct Architect and standalone callers retain their dispatch
owners. Only a successful captured raw reply establishes input delivery and
initialization. A later phase-validation refusal does not erase that delivery;
a pre-Prompt refusal or uncertain completion establishes none. Dispatch receipts
link the exact selection to the original recipient, execution and result. The
foundation passes its saved Planner call and factual delivery into migration;
standalone preparation has no delivery ledger or replacement reducer.

Reduction and comparison prompts run in the original Planner's conversation from
the same repository directory as its productive calls, behind the same
`Phase.Session` identity guard: a changed or unconfirmed identity holds before
the prompt and spends that preparation stage.

## Diagnose a failure

Run a problem-solver phase from the workflow repository. Select a clean checkout
at the failing commit, a new attempt directory outside the checkout and its Git
directories, and captured evidence such as the first failing output and a
passing comparison. On macOS the provider uses `sandbox-exec`. On Linux it
requires `bwrap` with unprivileged user namespaces and `--disable-userns`
support. If the sandbox cannot start, the phase holds before any prompt.

Save a request with these fields and replace the example paths and revision.

```json
{
  "role": "problem-solver",
  "session": "issue-1143",
  "attempt": "/absolute/path/to/records/diagnosis-1",
  "inputPaths": ["/absolute/path/to/first-failure.log"],
  "assignment": {
    "work": "#1143",
    "repository": "/absolute/path/to/source",
    "revision": "1111111111111111111111111111111111111111",
    "request": "Find which observation distinguishes the cause of this failure."
  }
}
```

```sh
deno task xmd run --allow-absolute examples/adversarial-implementation/phase.md \
  --props-request /absolute/path/to/request.json \
  --include examples/adversarial-implementation/components --raw
```

Fable starts the diagnosis. If its option inspection fails, its model is
unavailable, or it returns a recognized usage-limit refusal, a fresh assignment
can try Astra once. Each provider has its own attempt directory and conversation.
An uncertain turn, invalid reply, or failed continuation holds for reconciliation.

The attempt retains the assignment, evidence snapshots and fingerprints, model
selection, and provider outcome. A completed turn also leaves its raw reply.
The result contains either the evidence, discriminating regression and Opus
handoff for a cause, or the missing witness and how to obtain it. Diagnosis
returns that receipt to the coordinator. Implementation and independent review
run through their own entries.

To add evidence after a saved result, keep the work, repository, revision and
session, choose a new `attempt`, and set `previous` to the previous returned
`attempt` path, including its `fable` or `astra` directory. List new evidence
in `inputPaths`. Earlier snapshots retain their original bytes. The phase checks
the original model and conversation before prompting. Preserve any interrupted
attempt and its original receipt for reconciliation. To use an earlier Delivery
conversation as context, supply its retained records as evidence and leave them
in place.
