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

The following names describe the JSON these agents produce. They are labels for
shapes these documents declare inline, not component return declarations, not
entries in a schema registry, and the workflow does not assume a
`<Prompt schema>` prop. Each name is used for exactly one shape, here and in
the stage that produces it.

- `PlannerHandoff` separates user decisions from implementation hypotheses.
- `ImplementationPlan` records confirmed and refuted assumptions, evidence,
  validation, environmental effects, and pull-request boundaries.
- `PlannerVerdict` records pass/fail state, evidence, user questions, and a
  focused revision prompt.
- `ImplementationResult` records changed files, proposed commit metadata,
  validation, and newly discovered scope.
- `PullRequestVerdict` records findings, dispositions, evidence, user
  questions, and a focused revision prompt.
- `UserInvolvementAssessment` records whether involvement is required, the
  material choice, viable options, consequences, evidence, and recommendation.
- `UserDecision` records the request, options, selection, rationale, actor, and
  time.

Prompt output used for control flow is JSON parsed against captured draft-07
JSON Schema content. `<SafeParse>` exposes the candidate and normalized errors
for a visible, bounded correction turn; a final `<Parse>` prevents invalid data
from reaching control flow or deterministic effects. Prose capture remains
acceptable when no later transition depends on internal fields.

Parsing content inside a document and declaring a component's return value are
separate mechanisms, and both are shipped. A stage component could declare
`returns` and hand its caller the parsed verdict directly instead of rendered
text; these documents keep the text form because each stage's output is also
material a user reads at a checkpoint.
