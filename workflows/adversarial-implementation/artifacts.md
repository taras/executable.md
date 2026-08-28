# Retained Run State and Structured Results

Every consequential input, result, decision, and durable effect is explicit
workflow data. Agent session history may assist reasoning but is not the only
record of a decision.

## What the run retains

The retained store exists. A workflow run owns one SQLite database that is the
physical retention boundary for logically separate data
([#291](https://github.com/taras/executable.md/issues/291), shipped):

```text
WorkflowRun SQLite
├── filtered journal events and effect results
├── versioned Workspace roots and content
├── Repository and Worktree metadata
└── Agent-session mappings
```

Alongside the journal the run retains its immutable identity — run ID, workflow
definition, definition base, normalized props — one of six statuses, a nullable
stop reason, replaceable retrieval metadata, and one document-execution record
per start and per resume. `xmd workflow start` and `xmd workflow resume` create
and continue that record ([#366](https://github.com/taras/executable.md/issues/366),
shipped). A run is found by its public run ID alone: discovery
is arithmetic on that ID and no second registry can disagree with what is
stored. Damaged or incompatible storage is described and left exactly as found;
nothing migrates, truncates, or replaces it.

There is no sidecar Git history. Earlier drafts of this document put artifact
versions in Git objects under `refs/xmd/runs`; run state lives in the run's own
database instead, which is why a run survives a repository the workflow never
pushed to.

## One expansion, one effect, one transaction

Every Workspace-local expansion publishes atomically
([#365](https://github.com/taras/executable.md/issues/365), shipped):

```text
BEGIN
  apply the filesystem, Git or metadata mutation
  publish the resulting logical Workspace root
  append the filtered journal result
COMMIT
```

All three commit or none does. A host killed mid-effect publishes nothing: the
next connection recovers the last committed state, from which no recorded effect
is performed again. Nested effects finish their transactions before their
parent's effect begins.

That boundary is what a stage's writes actually get. A `<File>` the constrained
evaluator expands, a `<Git.Add>`, and a `<Git.Commit>` are each one expansion,
one effect, and one transaction — never a bundle the enclosing commit rolls back
together.

External effects cannot join it. `<Prompt>`, `<Git.Push>`, `<PullRequest>`, and
`<Issue>` derive a stable identity from the workflow run and the expansion, ask
the provider to perform or reconcile that identity, and then append one local
result transaction. Replay adopts proven compatible completion, performs proven
absence, and refuses conflict or permanent ambiguity rather than duplicating an
effect whose completion is unknown (#297).

## The journal is evidence, and the evidence is witnessed

Journal events reach storage already filtered, through the pre-persistence
secret gate, and that gate is **default-on** (#199, delivered by #573 and #575).
Offline detection is installed before the first live event. An offending durable
event is refused before persistence; a rendered chunk the scanner cannot clear is
withheld whole, while an earlier cleared prefix stays observable. Withholding
carries no settlement authority of its own — the journal gate owns rejection, and
the execution settles failed with the filtered `SecretDetectedError` after
teardown, so the journal retains only the safe preceding events and the safe root
`Close(err)`. Diagnostics name the rule and never the matched value, and replay
restores already-filtered output without rescanning it. `--no-secret-detection`
is a host-only, invocation-wide diagnostic escape hatch that warns before
execution; it is not a document prop and not a middleware permission.

Filtering is also where a subtle authority question lives, and it is answered
explicitly. `JournalProvenance` is a non-operational, equality-only witness that
a live publication stream descends from the exact journal backend a provider
selected for one workflow run. It grants no append, read, execution, publication,
or reconciliation capability; it is meaningful only because the provider retains
the witness it established and later requires exact equality. The generic
pre-persistence guard preserves nothing, while the trusted secret-filter wrapping
site preserves provenance explicitly — so a filtered journal, including one
wrapped more than once, still carries the witness its source carried. An
in-memory stream, another run's journal, a copied property, an ordinary guard, or
a look-alike is refused before any mutation or publication.

For this workflow that is the difference between "the history says the pull
request was created" and "this history is the one this run wrote."

The same principle decides where a run's own preparation comes from. A trusted
host installs it at the host boundary — an admission canonical core applies
inside its own journal read, and a durable preparation it runs inside the durable
root, ahead of every public document policy, the root import, and every authored
effect. Public middleware composed around the execution or the document expansion
may inspect what it is handed, narrow it, install contextual behavior, refuse, and
delegate, and nothing it returns is read: it cannot bring an execution or an
expansion into being, substitute one, or publish an outcome
([#432](https://github.com/taras/executable.md/issues/432),
[#433](https://github.com/taras/executable.md/issues/433)). Security authority,
retained identity, and outcome reconciliation never read replaceable contextual
state, which is why a run's history is evidence rather than an account anything
composed alongside it could have written.

Every committed journal event also references the logical Workspace root current
when it was written. Only committed event boundaries are checkpoints, which is
what makes an event selectable for a history fork later (#368).

## Reading the history

`xmd workflow history <run-id>` exposes stable public event IDs with each
event's operation, authored source position, result or normalized error, and
Workspace root:

```text
EVENT  OPERATION     SOURCE              RESULT      WORKSPACE
E14    File          start.md:31:5       completed   V7
E15    Agent.Prompt  Discovery.md:23:7   <summary>   V7
E16    Git.Add       Implementation.md:207:7  completed   V8
E17    Git.Commit    Implementation.md:208:7  6f21a9…     V9
```

That surface is shipped ([#460](https://github.com/taras/executable.md/pull/460)
delivering #367's first slice): `xmd workflow status <run-id> [--json]`,
`xmd workflow list [--status=<status>] [--json]`, and
`xmd workflow history <run-id> [--json]`.

What makes it safe to read a run someone else may be running is what it refuses
to do. Each command answers from an immutable lifecycle snapshot: it takes no
execution handle and no executor lease, performs no replay and advances nothing,
attaches no Workspace and materializes no root, imports no document, contacts no
Agent, process, or external provider, and reconciles and appends nothing. History
reads already-filtered retained protocol events, so it exposes nothing the
security policy has not already seen, and it never reconstructs a filtered value
from the Workspace or the provider. The authored source position it prints is
descriptive evidence about an event, never identity — nothing is located by
reconstructing a position from an expansion ID, the current definition, or the
Workspace.

**A crashed run is inspectable, from a private copy** (#521, shipped). Ordinary
inspection reads the retained snapshot and costs nothing extra. Only one
condition falls through to recovery: SQLite's exact
`SQLITE_READONLY_ROLLBACK` — a hot rollback journal a lost host left behind,
which a read-only connection may not put back. The extended code is the whole
signal, because the primary readonly conditions describe a database nobody may
write for other reasons and answering those with recovery would be guessing.

The retained database and its journal are copied under recovery coordination,
and SQLite rolls the journal back into the *copy*. The authoritative crashed
source stays byte-identical, exactly as its lost host left it, still waiting for
the write-capable owner whose job recovery actually is. Coordination is held for
the copy and released before the copy is recovered; it grants no executor or
lifecycle authority and opens no Workspace or provider effects. `list` stays
complete-or-error: it reports every run or it fails, never a partial listing
that silently omits the crashed one.

`history --forkable` adds a forkability column and a blockers column, and
removes nothing — so a caller that does not ask for them reads the same history
it always did. Selecting an event to fork from is shipped (#368, delivered by
#498): compatible forks, forkability reasons, lineage, changed-definition replay
admission and retained Workspace-root copying. A fork writes its own run record
and its own root import, and inherits everything after them unchanged, so
lineage is what it carries rather than identity.

Part of what history reads is journaled by the constructs the workflow already
writes. `<Loop>` records every iteration
it enters and one terminal `break`, `exhausted`, or `error` outcome, and refuses
a replay that disagrees with what this execution reached. Each `<Prompt>` is one
durable operation carrying its identity, input, agent and session, terminal
status, text, and structured failure. `<Elicit>` journals its validated answer
keyed by a fingerprint of the compiled schema and the rendered message, so a
resumed execution restores the answer instead of asking twice and refuses one
recorded against a different question.

A command's result is retained on the same terms, and retention is the host
path's decision rather than the document's. `start` and `resume` keep the exit
status and both channels the run received at its per-exec boundary, whatever the
document's display policy showed a reader, because a resumed procedure reads a
command's output back instead of running it again; `xmd run` keeps them only for
a diagnostic journal it was asked for. Retained text crosses the pre-persistence
secret gate like any other journaled field, and what it says is what reached the
boundary after the host's own stdio middleware — a host may redact a credential
upstream, and one that introduces credential-shaped text upstream is refused like
any other run that would persist one. `Process.join()` may settle before the
output pumps finish, so a tail written as they settle may never reach that
boundary; effectionx #244 owns the stronger guarantee and none is claimed here.

**A nonclaim: who answered.** The journal records the validated decision, the
question fingerprint, and the document execution it belongs to. It records no
actor identity behind an elicitation response, so a decision is attributable to
a run and an expansion rather than to a person. That is deliberate rather than
pending: this workflow does not attest actors, and nothing in it degrades
because it does not.

## Replay restores; it does not re-perform

Replay rehydrates the Effection tree. A completed durable effect restores its
recorded result without executing again; ephemeral operations run again only to
rebuild live structure — attach the Workspace, enter lexical working-directory
scopes, attach providers, and reattach the Agent session arrangement the strict
profile uses: an empty provider-owned directory and the retained mapping that
names the conversation. No directory is registered with an Agent, because none
ever is.

The Workspace stores the current frontier; the journal stores the execution that
reached it. Replay never asks current state to prove a past effect: a file
written and later deleted is absent at the frontier while both completed effects
still restore in order. Nothing infers completion from a filesystem guard.

A completed root result returns without expanding the document and without
attaching a Workspace, an Agent, or an external provider — which is why replaying
a finished run does not reclone, recommit, or repush. Missing or corrupt
authoritative Workspace state fails explicitly instead of being silently
recreated.

Prompts therefore receive their content from restored values rather than from a
file an agent was asked to locate and read. Persisting a generated handoff file
does not reduce model tokens either: reading it adds its content to context and
normally adds tool-call overhead. Files remain useful as explicit exports or when
an external tool requires a path; they are derived views, not canonical run
state.

## Structured results

A component has one return path, defined by the
[executable MDX specification](../../specs/executable-mdx-spec.md). A Markdown
component that declares no `returns` is a **text component**: its rendered
Markdown is its return value, `<Output>` selects which region renders, and `as`
binds that text. `InstructionFiles` and `Discovery` are ones. A component
that declares `returns` is a **value component**: it renders nothing, holds
exactly one direct top-level `<Return value={…} />`, must be invoked with `as`,
and binds one JSON value validated against its schema. The two are mutually
exclusive — `<Output>` in a component that declares `returns` is a structural
error.

A registered function component that declares no `returns` binds **by
reference**: `as` binds the object the component returned rather than a
rendering of it, which is how a component hands its caller something a schema
could not describe. Such a binding is not durable — nothing is journaled for
it, and a re-expansion recomputes it by running the component again.

`returns` is the opt-in that makes a particular return a **validated JSON
record** instead. The produced value crosses the JSON boundary before its
schema, validation runs against a clone so defaults fill without mutating the
producer's object, and only that normalized clone reaches the caller. `<Glob>`
declares `returns`, so the `string[]` this workflow binds is that validated
clone rather than a by-reference binding.

A component declaring `returns` must be invoked with `as`, because it renders
nothing. Without `as` there is nowhere to bind, so only text is observable: a
component returning a string renders it, and a component returning anything
else renders nothing — not an error, a value with no destination.

### What a failing stage returns

Nothing partial. A text component's `<Output>` region runs under the `output`
error mode and everything outside it under `throw`. A value component has no such
split — it renders nothing, so `<Output>` inside one is a structural error — and
its whole body runs fail-fast. Either way an undecided error fails the document
execution rather than producing a result the caller would bind, and a value
component that fails binds nothing at all: there is no half-validated return. A
failing `<Output>` region keeps only the text it had already rendered, and that
text reaches the output stream; nothing after the failure does. A failed document
execution is still a complete record — replay restores its output and its failure
without re-executing anything.

None of that changes when a stage is reached through an invocation. Content a
caller projects keeps the error mode of the region it is written in, so a
component's own `printErrors(fn)` declaration governs the component's work and
never the caller's text: an unrecovered projected failure passes outward wherever
the caller's region does not print, and the partial text the projection rendered
belongs to that caller's region and reaches its output, exactly once
([#446](https://github.com/taras/executable.md/issues/446)).

### Logical result contracts

These names label the results the stages pass between each other. They are not
component return declarations and not entries in a schema registry, and the
workflow does not assume a `<Prompt schema>` prop. They fall into three kinds,
and the difference matters: only the parsed ones can be branched on.

**Prose.** No schema, no parsing. Text a stage produces and a later prompt
quotes, because nothing downstream reads an individual field.

- `PlannerHandoff` — what `Discovery` returns, and the one result that is a
  whole component's rendered output. It separates user decisions from
  implementation hypotheses in prose the implementor reads, and the sections it
  should contain are listed in [`Discovery`](./Discovery.md) rather than
  enforced by a schema.
- `ImplementationPlan` — the `plan` field inside `Planning`'s structured return.
  Confirmed and refuted assumptions, evidence, validation, environmental
  effects, and pull-request boundaries appear inside it, because it is one
  `<Prompt>`'s rendered reply.

Neither is validated, so neither can gate a transition. `Planning` branches on
the separately parsed `PlannerVerdict`, not on the plan text.

**Parsed JSON.** Each has a draft-07 schema captured inline in the stage that
produces it, and each description below names only fields that schema actually
declares.

- `PlannerVerdict` — `passed`, `review`, `revisionPrompt`
  ([`Planning`](./Planning.md)). Evidence and any user question live inside the
  `review` prose; they are not separate fields.
- `ImplementationProposal` — `changes`, `title`, `commitMessage`, `report`
  ([`Implementation`](./Implementation.md)). `changes` is the XMD fragment the
  read-only implementor returns for the constrained evaluator; `title` is the
  pull request's; validation and newly discovered scope are reported inside
  `report`. There is no separate
  `changedFiles` list: the fragment already says what it writes, and a second
  copy is one no schema could hold in agreement with the first. The authoritative
  set of paths is what `<Git.Add>` staged and `<Git.Commit>` journaled.
- `PullRequestVerdict` — `passed`, `review`, `revisionPrompt`, and `findings`,
  each finding carrying `disposition`, `title`, `description`, and `evidence`
  ([`Implementation`](./Implementation.md)).
- `UserInvolvementAssessment` — `requiresUser`, `assessment`, `question`,
  `options`, `recommendation` ([`UserCheckpoint`](./UserCheckpoint.md)).

**Declared returns.** `UserCheckpoint`, `Planning`, and `Implementation` declare
`returns`, so their results are validated JSON values bound through `as` rather
than text a caller would have to interpret.

- `UserDecision` — the transition decision a caller gates on. `UserCheckpoint`
  returns it directly, and `Planning` and `Implementation` each return the one
  they resolved internally, alongside their prose and their parsed verdict's
  fields. A stage that resolved a user decision cannot return prose alone: its
  caller has nothing to branch on, and the authority the checkpoint exercised
  would be lost at the boundary. Two parts combine into it. The **decision** is
  `proceed`, `response`, and `rationale`, validated against one schema on both
  paths: `<Elicit>` binds it when the assessment reports a material choice, and
  an explicit `<Parse>` binds it when there is none. `UserCheckpoint` returns
  those alongside the assessment fields, so one value carries both the gate and
  the material a later prompt quotes.

A stage returns those sources and nothing derived from them. `start.md` computes
its gate as `decision.proceed && verdictPassed` where it uses it, rather than
reading a field the stage precomputed: a return schema can require both fields to
be present but cannot require a derived flag to agree with them, so a record
pairing a declining decision with an approving flag would validate. The same two
fields tell a decline (`proceed` false) from a review that never passed
(`proceed` true, `verdictPassed` false), so no separate outcome label is needed
either.

Neither stage *returns* the pull-request handle, and the boundary is worth
stating exactly. `<PullRequest>` (#295, shipped) resolves a minimal result —
filtered Repository identity, stable provider identity, number, URL, open state,
head SHA, and base SHA. Reviews, comments, checks, labels and merge state are
separate reads rather than freshness smuggled into it, so a replayed run hands
back exactly what the run recorded.
`Implementation` consumes it internally, together with the separately observed
review state its prompt needs; `start.md` never receives it. What crosses the
stage boundary is the verdict and the decision it gates on, and the filtered
journal records the external effect independently.

A return field typed `string` would be actively harmful: `<PullRequest>` would
perform its external effect and only then fail the stage's return validation. If
a later caller needs the handle, it is declared with #295's settled object
schema.

Prompt output used for control flow is JSON parsed against captured draft-07
JSON Schema content. `<SafeParse>` exposes the candidate and normalized errors
for a visible, bounded correction turn; a final `<Parse>` prevents invalid data
from reaching control flow or a durable effect. Prose capture remains
acceptable when no later transition depends on internal fields — which is
exactly the line between the first group above and the second.

Parsing content inside a document and declaring a component's return value are
separate mechanisms, and both are shipped. Which one a component uses follows
from what its caller does with the result. `InstructionFiles` and `Discovery`
produce material a prompt quotes, so text is enough. `UserCheckpoint`,
`Planning`, and `Implementation` each resolve a decision the caller must branch
on, and a caller cannot branch on prose without guessing — so they declare
`returns` and hand back validated values. The human-readable report is rendered
by `start.md` from those fields, which is the same material, addressed rather
than pre-flattened.
