# Artifacts and Structured Results

Every consequential input, result, decision, and durable effect is explicit
workflow data. Agent session history may assist reasoning but is not the only
record of a decision.

## The artifact ledger

The artifact ledger is not implemented. This section describes what
`<Workflow>` must do once it exists (#291).

Artifact versions live in Git objects reachable from `refs/xmd/runs` — sidecar
Git history. They remain in the repository without appearing in the main source
tree or source history. Each run records the pinned source revision it
investigated.

<Workflow historyRef="refs/xmd/runs">
  <Content />
</Workflow>

The first exercise uses ordinary Git commands to create, update, push, and
fetch this history. Objects must remain reachable through a ref. Content is
screened for credentials and other data that must not become durable — the
default-on execution policy for that screening is #199.

`<Workflow>` derives the ledger's entries from the execution record. It records
the pinned source revision, component and loop-iteration identity, named
captures, props, file effects, agent results, user decisions, Git and GitHub
effects, outcome, and stop reason. Each captured result becomes an immutable
artifact version with a content hash. It appends when a stage or loop iteration
completes and writes a terminal record when execution succeeds, fails, or is
cancelled.

Part of that identity already exists in the execution journal. `<Loop>` records
every iteration it enters and one terminal `break`, `exhausted`, or `error`
outcome, and refuses a replay that disagrees with what this run reached. Each
`<Prompt>` is one durable operation carrying its identity, input, agent and
session, terminal status, text, and structured failure, and `<Elicit>`
journals its validated answer keyed by a fingerprint of the compiled schema
and the rendered message. Those are execution records rather than the artifact
ledger: what is missing is one run identity that correlates them, artifact
versions on top of them, and persistence outside the process.

When a later stage resumes the same run, `<Workflow>` restores its declared
inputs from those recorded values. Required workflow context is rendered
directly into the next prompt. The agent is not asked to locate or read a
generated handoff file, so prompt construction does not depend on tool use,
working directory, permissions, or mutable filesystem content.

Persisting a generated file does not itself reduce model tokens: reading the
file adds its content to context and normally adds tool-call overhead. Files
remain useful as explicit user exports or when an external tool requires a
path, but they are derived views rather than canonical run state.

## Structured results

A component has one return path, defined by the
[executable MDX specification](../../specs/executable-mdx-spec.md). A Markdown
component that declares no `returns` is a **text component**: its rendered
Markdown is its return value, `<Output>` selects which region renders, and `as`
binds that text. Every stage component in this workflow is one. A component
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

Nothing partial. A stage's `<Output>` region runs under the `output` error mode
and everything outside it runs under `throw`, so an undecided error at either
position fails the run rather than producing a result the caller would bind. A
failing `<Output>` region keeps only the text it had already rendered, and that
text reaches the output stream; nothing after the failure does. A failed run is
still a complete record — replay restores its output and its failure without
re-executing anything.

### Logical result contracts

These names label the results the stages pass between each other. They are not
component return declarations and not entries in a schema registry, and the
workflow does not assume a `<Prompt schema>` prop. They fall into three kinds,
and the difference matters: only the parsed ones can be branched on.

**Prose.** No schema, no parsing. The stage renders text and its caller binds
that text, because nothing downstream reads an individual field.

- `PlannerHandoff` — what `Discovery` returns. It separates user decisions from
  implementation hypotheses in prose the implementor reads, and the sections it
  should contain are listed in [`Discovery`](./Discovery.md) rather than
  enforced by a schema.
- `ImplementationPlan` — what `Planning` returns. Confirmed and refuted
  assumptions, evidence, validation, environmental effects, and pull-request
  boundaries appear inside `plan`, which is one `<Prompt>`'s rendered reply.

Neither is validated, so neither can gate a transition. `Planning` branches on
the separately parsed `PlannerVerdict`, not on the plan text.

**Parsed JSON.** Each has a draft-07 schema captured inline in the stage that
produces it, and each description below names only fields that schema actually
declares.

- `PlannerVerdict` — `passed`, `review`, `revisionPrompt`
  ([`Planning`](./Planning.md)). Evidence and any user question live inside the
  `review` prose; they are not separate fields.
- `ImplementationResult` — `changedFiles`, `commitMessage`, `report`
  ([`Implementation`](./Implementation.md)). Validation and newly discovered
  scope are reported inside `report`.
- `PullRequestVerdict` — `passed`, `review`, `revisionPrompt`, and `findings`,
  each finding carrying `disposition`, `title`, `description`, and `evidence`
  ([`Implementation`](./Implementation.md)).
- `UserInvolvementAssessment` — `requiresUser`, `assessment`, `question`,
  `options`, `recommendation` ([`UserCheckpoint`](./UserCheckpoint.md)).

**A declared return.** `UserCheckpoint` is the one value component here, so its
result is a validated JSON value bound through `as` rather than parsed out of
rendered text.

- `UserDecision` — the transition decision a caller gates on. Two parts combine
  into it. The **decision** is `proceed`, `response`, and `rationale`, validated
  against one schema on both paths: `<Elicit>` binds it when the assessment
  reports a material choice, and an explicit `<Parse>` binds it when there is
  none. `UserCheckpoint` returns those alongside the assessment fields, so one
  value carries both the gate and the material a later prompt quotes.
  **Missing:** the provenance that makes a decision auditable after the fact —
  which actor answered, when, against which run and stage — belongs to the
  artifact ledger (#291) and does not exist. Nothing in the returned value
  identifies the person who answered.

Prompt output used for control flow is JSON parsed against captured draft-07
JSON Schema content. `<SafeParse>` exposes the candidate and normalized errors
for a visible, bounded correction turn; a final `<Parse>` prevents invalid data
from reaching control flow or deterministic effects. Prose capture remains
acceptable when no later transition depends on internal fields — which is
exactly the line between the first group above and the second.

Parsing content inside a document and declaring a component's return value are
separate mechanisms, and both are shipped. The stages keep the text form because
each stage's output is also material a user reads at a checkpoint.
`UserCheckpoint` is the exception, and the reason is the distinction above: its
result is not something a user reads, it is something the workflow branches on.
A checkpoint that returned prose could not gate anything — a caller would have
to guess consent from text — so it declares `returns` and hands back a validated
decision instead.
