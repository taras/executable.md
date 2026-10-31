# Adversarial implementation

Deliver accepted work through one launch. Prepared scope facts select direct
implementation, ordinary planning followed by implementation, or a validated API
foundation followed by remaining consumer migration. Existing impact policy
selects independent review separately from that route.

## Applies to

Ordinary XMD runs and REPL entry programs. Each new work item has an isolated,
prepared source checkout, an exact clean source revision, a fresh artifact
directory outside that checkout, and three distinct original role sessions. One
role runs at a time. These components are a repository example; they do not
change a running role's model or a live workflow's include directory.

## Run a work item

Prepare this repository with `deno task setup`. Copy `task.example.json` to a
local file and replace its source, exact revision, output directory, accepted
request, selected evidence paths and unused session names. Prepare the selected
source through its own repository instructions. Its feedback commits use its
configured Git signing and verification. Run from that source checkout:

```bash
cd /absolute/path/to/prepared-source-worktree
xmd run /absolute/path/to/workflow/examples/adversarial-implementation/run.md \
  --props-task /absolute/path/to/task.json \
  --include /absolute/path/to/workflow/examples/adversarial-implementation/components --raw
```

`run.md --props-task` is the normal launch for all three routes. Inspect its
complete CLI with `xmd run /absolute/path/to/workflow/examples/adversarial-implementation/run.md --help`.
The task has no mode, phase, full flag or initialization override. `phase.md`
and `continue.md` below serve separate assignments and existing records.

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
| `migration=null`, `sharedApi.needed=false`, `implementation.ready=false` | Ordinary Planner plan/evidence, then Implementor and selected review |
| `migration=null`, `sharedApi.needed=true`, either readiness value | Ordinary Planner plan/evidence, then one Implementor for necessary API work and consumers, followed by selected review |

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
        |                              Planner plan/evidence -> Implementor
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
with no fabricated phase call or checkpoint. Simple and standard return the
existing Ticket record; migration returns the existing Adversarial result.
Provider and persistence failures retain their existing handling. Preserve first
failure output and partial effects before another attempt.

An occupied fresh-work directory holds; it is never an implicit retry or
continuation. An ordinary command's diagnostic journal is not a continuation
checkpoint. Reconcile its saved calls and partial effects before new work. In a
retained REPL, reopen the original unfinished entry under its selected source
and include version. Keep the original session identities and recorded inputs.

The roles use the normal agent permission policy. Running this example invokes
paid coding agents and permits the assigned implementation work. Publication,
issue/PR metadata and delivery remain with the Sidekick running Codex.

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
deno task xmd run examples/adversarial-implementation/phase.md \
  --props-request /absolute/path/to/request.json \
  --include examples/adversarial-implementation/components --raw
```

The command returns the canonical phase result. `Phase.Run` saves its assignment,
raw reply, result, status and acceptance receipt beneath the request's attempt.
Source and role checks run before a prompt. Reusing an occupied attempt refuses;
inspect its saved effects before selecting another attempt.

To advance a saved `Ticket.Run` or `Ticket.Continue` record, pass that complete
record rather than reconstructing its assignment or artifact paths:

```bash
deno task xmd run examples/adversarial-implementation/continue.md \
  --props-record /absolute/path/to/ticket-record.json --props-steps 1 \
  --include examples/adversarial-implementation/components --raw
```

The returned record preserves the original manifest, sessions, documents, calls
and correction counts. Each step executes at most one recorded role. Held and
completed records return without a prompt. This entry does not clear a hold or
retry an uncertain execution. Resolve the recorded cause before preparing a
continuation, and preserve the original evidence. Capture the complete output
under a new filename when retaining the next record; do not redirect it over
the input file.

External reviewer models and publication use their existing workflows. The
phase entry retains the implementation workflow's role and model policy.

## Responsibilities and models

| Owner | Work | Model and effort |
| --- | --- | --- |
| Planner | Ordinary plan/evidence; on migration, implement the API, validate representative consumers and repair API conflicts | Claude `opus`, high |
| Implementor | Implement accepted work; on migration, challenge the API, convert consumers and delete obsolete machinery | Claude `sonnet`, high |
| Planner reviewer | Inspect the migration against the accepted outcome and evidence | Same Opus session, medium; high for a concrete recorded risk |
| Architect | Answer a concrete structural question or review structural impact | Codex `gpt-6.1-sol`, medium; high for a concrete recorded risk |
| Sidekick running Codex | Author and apply issue/PR titles and descriptions; own publication and delivery | Existing coordinating Sidekick |

Aliases select the provider's available Opus and Sonnet models. The two Claude
roles do not draft or edit issue/PR titles or descriptions. The phase runner
refuses editorial assignments; technical handoffs and API documentation remain
part of the roles' work.

Architect is conditional: reserving its conversation name starts no discovery
call. A Planner can return `needs_architect` with one structural question. An
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
most three times. Every other field is frozen, including the API, source,
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
existing implementation-review corrections. Both default to three and accept
zero through ten. Repeated redesign is evidence that the split is not paying
for itself: inspect the saved consumer conflicts before extending either bound.

The imported feedback loop retains impact-selected reviews, bounded response
format repair and exact-patch conditional corrections. A known exact correction
can close after its authorized patch and checks match; ordinary corrections go
only to affected responsibilities. `feedback_ready` is neither CI completion
nor permission to merge. The Sidekick running Codex handles metadata and the
repository's normal delivery gates afterwards.

## Test without paid agents

```bash
deno task xmd test examples/adversarial-implementation/tests/Workflow.test.md \
  --include examples/adversarial-implementation/tests/components \
  --include examples/adversarial-implementation/components
```

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
editorial ownership. Delivery
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
adapter remains. Do not ask Sonnet to validate a paper API by designing it from
scratch. The first handoff contains working consumer code and passing evidence;
the final handoff contains the finished retirement and review evidence.

## Read next

Read [Planner](../../.agents/planner.md) and
[Implementor](../../.agents/implementor.md) for role assignments.
Read `<Adversarial.Schema />` for the API handoff shape and `<ReviewPolicy />`
for impact-based review selection.
