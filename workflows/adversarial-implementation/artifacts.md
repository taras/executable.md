# Artifacts and Structured Results

Every consequential input, result, decision, and durable effect is explicit
workflow data. Agent session history may assist reasoning but is not the only
record of a decision.

## Sidecar history

Run artifacts live in Git objects reachable from `refs/xmd/runs`. They remain
in the repository without appearing in the main source tree or source history.
Each run records the source revision it investigated.

<RunHistory ref="refs/xmd/runs">
  <Content />
</RunHistory>

The first exercise uses ordinary Git commands to create, update, push, and
fetch this history. Objects must remain reachable through a ref. Content is
screened for credentials and other data that must not become durable.

`<RunHistory>` derives snapshots from the execution record. It records the
source revision, component and loop-iteration identity, named captures, inputs,
file effects, agent results, user decisions, Git and GitHub effects, outcome,
and stop reason. Each captured result is an immutable artifact version with a
content hash. It appends a snapshot when a manual execution or loop iteration
completes and when execution succeeds, fails, or is cancelled.

When a later manual stage resumes the same run, `<RunHistory>` restores its
named inputs from those recorded values. Required workflow context is rendered
directly into the next prompt. The agent is not asked to locate or read a
generated handoff file, so prompt construction does not depend on tool use,
working directory, permissions, or mutable filesystem content.

Persisting a generated file does not itself reduce model tokens: reading the
file adds its content to context and normally adds tool-call overhead. Files
remain useful as explicit user exports or when an external tool requires a
path, but they are derived views rather than canonical run state.

## Structured results

The following names describe logical result contracts. They are not entries in
a schema registry, and the workflow does not assume a `<Prompt schema>` prop.

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

This in-document parsing contract does not define typed results for imported
Markdown components. That separate boundary remains [Issue
#176](https://github.com/taras/executable.md/issues/176).
