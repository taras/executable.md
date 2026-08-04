# Adversarial Implementation Workflow

- **Status:** Living end-goal target
- **Audience:** Maintainers and contributors

This document describes a workflow for developing software with a user, a
planner agent, and an implementor agent. It is the target the runtime is being
built toward, and it is kept current as capabilities land: a settled contract is
described in the present tense, and a capability that does not exist yet says
so with the issue that would supply it. Sections marked as not implemented
define what must be built, not what the runtime does today.

The compact workflow map and its stage-level details live in
[the adversarial implementation workflow directory](../workflows/adversarial-implementation/start.md).

The executable sketch is organized around a compact
[entry document](../workflows/adversarial-implementation/start.md), with stage and
runtime details in adjacent Markdown files.

## Purpose

The workflow helps a user turn a design conversation into a sequence of
reviewable, validated changes without making hidden agent transcripts the source
of truth.

The planner and implementor are equally capable of analysis. Their roles create
useful opposition:

- The planner interviews the user, constructs a theory of implementation, and
  challenges plans and implementations.
- The implementor investigates the repository, validates the planner's theory,
  and proposes a concrete implementation plan.
- The user makes final decisions about behavior, scope, architecture, risk,
  sequencing, and lasting constraints.

The agents converge by exchanging evidence. Neither agent wins a disagreement
by role or authority.

An authored `<UserCheckpoint>` component asks its supplied agent whether the
next transition contains a material choice. It involves the user when one
exists or when the agent is unsure. The current workflow supplies the planner,
but the component does not encode that role. It may determine that user
involvement is unnecessary, but only the user resolves a material choice.

## Smallest complete path

User and planner discuss the change
  → Planner writes an implementor handoff
  → User validates the handoff when discovery was required
  → Implementor validates the theory and writes a plan
  → Planner reviews the plan
  → Implementor revises or the user resolves remaining decisions
  → User authorizes the shared plan
  → Implementor changes the repository
  → Planner reviews the pull request
  → Review and revision repeat until the change is accepted

Implementation does not begin merely because the planner produced a handoff.
The handoff is a theory for the implementor to test, not an implementation plan
to follow unquestioningly.

### Initial execution model

The first exercise runs one stage at a time under user control. Each stage reads
declared inputs, publishes explicit results, and returns. The user inspects the
result and manually starts the next stage.

This manual boundary lets the exercise test the interview, handoff, plan,
review, decision, and revision contracts without first implementing a resident
process, file watcher, suspension protocol, or resumable resource scope.

The automated form treats script execution as a loop. An iteration stops on the
first applicable signal in this priority order:

1. The iteration reaches its defined completion.
2. A configured file is created or updated in a configured directory.
3. The user provides direct input.

Stop arbitration is not implemented (#300). The manual exercise records where
each signal would have been used without detecting or prioritizing them.

Signal 3 has a shipped in-run form. `<Elicit>` asks a person a schema-validated
question during execution and binds the validated answer, and `xmd run`
composes the WebForm provider so that question opens a loopback browser form.
What remains missing is cross-process continuation: stopping at a stage
boundary and resuming in a later invocation. That belongs to `<Stage>` and
`<Workflow>` (#298, #289), so the user still supplies decisions between manually
invoked stages whenever a stage boundary — rather than a question inside one
run — is what stopped the work.

### Runtime intervention

The Effection inspector provides future meta-control over a running loop. It may
interrupt execution so that a user can inspect or manipulate program state
during a major runtime intervention.

Inspector control is distinct from ordinary workflow input. The workflow still
needs an in-band mechanism for routine user decisions; the inspector is an
out-of-band operational tool rather than the decision protocol. Neither
mechanism is required by the manual exercise.

## Entering the workflow

Work enters by one of two paths.

### Design discovery

A new, ambiguous, or design-sensitive request begins with a planner interview.
The planner asks for the decisions needed to produce a coherent handoff. The
user validates that handoff before it reaches the implementor.

The interview does not need to exhaust every possible detail. It establishes
enough intent, constraints, evidence, and open questions for the implementor to
investigate productively.

### A bounded deferred issue

An issue discovered while implementing or reviewing another change may go
directly to the implementor when it already states:

- the observed problem and supporting evidence;
- the desired observable outcome;
- relevant constraints and non-goals;
- why it was excluded from the originating change; and
- the originating issue, pull request, review, or execution.

If the issue leaves material behavior, scope, architecture, or risk unresolved,
it returns to planner discovery. Deferral does not make an unclear issue ready
for implementation.

## The planner handoff

The handoff records both user-validated design and a falsifiable implementation
theory:

- purpose and desired observable behavior;
- constraints, non-goals, and accepted risks;
- repository and architectural context;
- likely affected boundaries and change nucleus;
- the planner's proposed implementation theory;
- assumptions the implementor must confirm or refute;
- evidence and experiments needed to evaluate the theory;
- expected validation;
- likely pull-request topology; and
- unresolved decisions that remain with the user.

User decisions and planner hypotheses remain distinguishable. Later evidence may
invalidate a planner hypothesis without reopening settled product intent.

## Plan convergence

The implementor investigates before committing to the handoff's theory. Its plan
reports:

- confirmed assumptions and their evidence;
- refuted assumptions and their evidence;
- amendments to the theory;
- the proposed implementation and validation;
- expected environmental and public effects;
- pull-request boundaries and dependencies; and
- questions that require a user decision.

The planner reviews the plan against the user intent, repository evidence,
instructions, specifications, and observable validation. A failed review returns
a focused prompt that the implementor can apply directly.

Factual disagreement calls for more evidence. When evidence leaves more than one
viable choice, the agents present the options, consequences, and recommendations
to the user. Convergence means that the final plan reflects a shared
understanding and the user's decisions; it does not require the agents to have
started with the same preference.

Agents may decide reversible implementation details within the authorized plan.
They return choices affecting behavior, scope, architecture, risk, pull-request
decomposition, or lasting constraints to the user.

### Structured agent results

Agent output remains prose when later execution only needs to read it. Output
that controls a branch or deterministic effect is JSON validated against
draft-07 JSON Schema captured as ordinary document content.

`<SafeParse>` returns either a validated value or the candidate and normalized
validation errors, preserving the rendered input exactly so a correction prompt
can quote what was said. A bounded `<Loop>` uses nested `<If><Else>` control
flow to show any correction prompt explicitly in the producing agent's session.
Correction turns receive the candidate, validation errors, and schema; they do
not run tools, modify files, or perform additional analysis. A final `<Parse>`
fails the stage if the candidate remains invalid.

Validation judges the value and never edits it: no declared default is
inserted, no type is coerced, and no undeclared property is removed. What a
document binds is exactly what its content said.

Parsing and validation are shipped, provider-neutral core behavior. ACP
supplies an agent provider but does not own parsing or hidden repair behavior.
The workflow does not use named schema strings or a `<Prompt schema>` prop.

This in-document parsing is separate from a component's own return value, and
both are shipped. A component that declares no `returns` returns its rendered
Markdown, and `as` binds that text; a component that declares `returns` renders
nothing, holds one direct top-level `<Return>`, must be invoked with `as`, and
binds one schema-validated JSON value. The two are mutually exclusive.

A registered function component that declares no `returns` binds by reference:
`as` binds the object itself, and nothing is journaled for it. Declaring
`returns` is the opt-in that makes a return a validated JSON record instead —
the value crosses the JSON boundary, is validated against a clone, and only the
normalized clone reaches the caller. `<Glob>` declares `returns`, so the
`string[]` this workflow binds is that validated clone rather than a
by-reference binding.

Every stage component in this workflow is a text component, because each
stage's output is also material a user reads at a checkpoint.

### A stage fails rather than returning a half-record

A stage's `<Output>` region runs under the `output` error mode; everything
outside it is documentation and runs under `throw`. An undecided error at either
position fails the run rather than producing a result a caller would bind, and
no `<PrintErrors>` region can convert a documentation failure into a printed
error. That is what makes each stage's final `<Parse>` a gate: malformed agent
output cannot reach control flow or a deterministic effect.

A failing region keeps only what it had already rendered. That partial text
reaches the output stream; nothing after the failure does. Continuing after a
failure is always explicit — a bounded repair turn the document shows, not
recovery the engine performs on the author's behalf.

`throwOnError` on a `<Prompt>` is required for the same reason: without it a
failed prompt records its failure and returns its text, raising nothing for the
error mode to decide, and the stage would continue with an empty reply.

## Workflow-owned development assets

The workflow owns worktrees, working directories, captured handoffs, plans,
feedback, decisions, branches, issues, and pull requests. An agent does not own
an asset merely because its process created it.

Deterministic components provide and pass those assets. Two of them are
shipped:

- `<Glob>` resolves explicit include and exclude patterns against `Env.cwd`
  into a `string[]` of relative paths — `/`-separated on every platform,
  deduplicated, and sorted lexically by code point. Directories and symbolic
  links are never results.
- A self-closing `<File>` reads and renders exact repository content relative
  to `Env.cwd`, and `as` captures that text. Its content-writing form
  atomically replaces the target and renders nothing at all: no output, no
  path, no write handle. It is used for source changes, explicit exports, or
  external tools that require a path, not as the default agent handoff.

Two are not implemented:

- `<Worktree>` creates or resolves a workspace and sets `Env.cwd` while
  rendering its children (#293). The contextual working directory it would
  establish is itself shipped and already inherited by files, globs, processes,
  and agents.
- `<PullRequest>` creates or resolves the pull request for a branch and returns
  its identity and state (#295).

Each environmental operation declares its inputs and preconditions, reconciles
existing state, returns a structured handle, and records its observed effects.
Rerunning a pull-request operation resolves the existing pull request rather
than creating a duplicate (#297).

Nested agent prompts receive required handoffs, plans, reviews, decisions,
commit identities, and pull-request metadata as exact content. Repository
evidence remains available through paths and read tools for selective
investigation. The workflow does not depend on a user copying output between
agent transcripts or asking an agent to locate and read another agent's file.

### The artifact ledger

The artifact ledger is not implemented (#291). This section defines what
`<Workflow>` must provide.

Handoffs, plans, reviews, user decisions, and execution events live in sidecar
Git history rooted at `refs/xmd/runs`. They are Git objects in the same
repository, but they do not appear in the source tree or the history of the
main source branch.

Each run records the pinned source revision it investigated along with its
artifact contents and provenance. The sidecar ref keeps the objects reachable,
and the workflow pushes and fetches it explicitly because ordinary branch
refspecs do not imply transport of custom refs.

Captured results become artifact versions keyed by stable component and
loop-iteration identity. Resuming a named run restores those values and renders
required content directly into later prompts. A generated file is an optional
export, not canonical run state. Reading such a file does not inherently save
tokens because its contents still enter model context.

`<Workflow>` creates or resolves a run identity and installs it through a
contextual Run API (#289). Worktrees, decisions, pull requests, and issues
consume that identity internally. The workflow author does not pass it through
component props; the API exposes it only when authoring logic genuinely needs
the identity. That state is created inside the operation that owns it and torn
down with it — there is no module-scoped registry and no library object that
accumulates runs.

Ledger entries are automatic. A completed stage, a completed loop iteration,
and a terminal success, failure, or cancellation record the observed props,
artifact versions, decisions, effects, outcome, and stop reason. Authors do not
repeat those paths in an explicit checkpoint.

The execution journal already holds part of that material. `<Loop>` records
every iteration it enters and one terminal record whose outcome is `break`,
`exhausted`, or `error`, and refuses a replay whose stored outcome or iteration
count disagrees with what this run reached — there is no `cancelled` outcome
and no stage-stop record. Each `<Prompt>` is one durable operation carrying its
identity, input, agent and session, terminal status, text, and structured
failure. `<Elicit>` journals only its validated answer, keyed by a fingerprint
of the compiled schema and the rendered message, and refuses a recorded answer
whose question does not match the one this run computed. What is missing is one
run identity correlating those records, artifact versions above them, and
persistence outside the executing process.

Replay is what makes a resumed stage possible: a run that failed is still a
complete record, and replaying it restores the output and the failure without
re-executing anything. Replay arrives at the same state, where execution can
resume; it is not itself the continuation.

The first exercise creates and reads this history with ordinary Git commands.
It does not require an Executable.md component for artifact storage. Content is
screened for credentials and other data that must not become durable before it
is written to the history; that screening becomes a default-on execution policy
under #199.

### Experiment isolation

The run resolves and records its pinned source revision, then creates the
worktree before discovery. Planner discovery, handoff validation, implementor
planning, implementation, and review use the same pinned filesystem even if the
base branch moves.

A worktree isolates experimental Git state from the user's current checkout,
but it is not a security boundary. A supervised manual exercise combines that
disposable worktree, the narrowest available agent permission policy, a
deliberately limited task, and explicit user approval before durable or remote
effects.

`<Worktree>` (#293) and `<Sandbox>` (#302) are not implemented. `<File>` and
`<Glob>` confine traversal to `Env.cwd` today, but that guarantee is about
traversal rather than about the filesystem being stable: a directory that is
real when it is read could be replaced afterwards. Containment that does not
depend on observed filesystem state is issue #227, and an unattended loop is
bound to its resolution.

An unattended implementation loop requires an enforceable sandbox boundary. Its
policy declares:

- readable and writable roots;
- inherited working directory;
- available environment variables and secrets;
- process and command capabilities;
- network destinations and operations; and
- which deterministic components may perform durable Git or GitHub effects.

The planner normally receives repository read and search access. The
implementor receives write access only to the workflow-owned worktree.
Deterministic components receive narrow capabilities for sidecar Git history,
worktree metadata, commits, issues, and pull requests rather than passing those
capabilities through an agent prompt. The implementor does not require write
access to the repository's shared Git metadata.

The sandbox owns the processes it starts and closes them with its execution
scope. Retaining a worktree preserves filesystem evidence after the processes
stop; it does not preserve running effects or broaden their permissions.

### Cleanup and recovery

Resources clean up with their execution by default. Agent sessions, processes,
streams, and other ongoing effects always stop before their enclosing scope
closes.

An execution may explicitly retain its workspace for inspection. A failed or
cancelled execution also retains a worktree when removing it would discard
uncommitted or unpushed changes. The execution reports the retained path, branch,
state, and recovery reason.

Durable published effects such as commits, issues, and pull requests remain
after temporary execution resources close.

## Reviewable pull-request chains

A feature is designed outside-in: desired behavior, public contracts,
architectural spine, and validation boundaries precede internal implementation
details.

The pull-request series is ordered according to the topology of the change.
Vertical feature slices often remain outside-in. Infrastructure, abstraction,
migration, or fan-out work may use dependency, inside-out, execution, data-flow,
or risk order when that makes each change easier to understand and validate.

Pull requests optimize for comprehension rather than a fixed line count. A
reviewable pull request normally has:

- one falsifiable behavioral claim;
- one primary change nucleus or coherent cluster;
- understandable fan-out from that nucleus;
- explicit invariants and deliberate non-changes;
- independent validation evidence;
- a safe state when merged without later slices; and
- a review path that lets the user reconstruct the change without reading the
  diff linearly.

Multiple unrelated nuclei, tangled concerns, and independent behavioral claims
are stronger reasons to split than raw size. Broad mechanical fan-out may remain
reviewable when its nucleus is clear and mechanical or generated changes are
identified.

The planner proposes decomposition, the implementor validates dependencies and
feasibility, and the user decides material sequencing or scope choices.

## Review findings and deferred obligations

A review finding has four possible dispositions:

1. Fix it in the current pull request because correctness depends on it.
2. Insert a focused repair because the remaining pull-request chain depends on
   it.
3. Create a provenance-linked issue because the problem is valid but fixing it
   now would derail the current chain.
4. Reject it because it is unsupported, unrelated, or intentionally outside the
   product direction.

The planner selects a disposition from the evidence and asks the user for
verification when scope, impact, or urgency is uncertain. The user may override
the classification.

A deferred issue records:

- the originating review and pull request;
- evidence that the problem is real;
- why it is outside the current slice;
- how immediate work would disrupt the chain;
- whether later slices depend on it;
- its intended timing, such as after the chain, before release, or backlog; and
- the pull request or decision that eventually resolves it.

After the planned chain completes, the planner audits deferred obligations and
decides which remain part of the initiative. It asks the user to verify that
decision when uncertain. Creating an issue is therefore a scope-preservation
operation, not silent abandonment.

## The lab and `xmd play`

The lab initially remains conceptual. At each stage, the user and agents inspect
the workflow, identify friction, and decide what to change about the process.
The workflow does not modify itself.

The automated implementation loop establishes the asset, decision, review,
cleanup, and recovery behavior needed by a later `xmd play` mode. Play turns the
document into a living collaboration surface where agents propose visible
executions or document changes, the runtime validates and enforces approved
effects, and the user remains the final authority for material changes.

Play follows a working implementation loop. It helps the user step back from
managing implementation mechanics and focus on the design of the workflow.

## First exercise

The first exercise uses this workflow to design its own initial automation.
The user triggers each stage manually within a named run. `<Workflow>` restores
captured values and renders required content directly into later prompts.
Generated artifacts do not appear in the repository or worktree unless the
user explicitly exports them.

Until `<Workflow>` and `<Stage>` exist, the exercise runs in one process and
one existing working directory. The document logic — instruction discovery,
the planner interview, plan convergence, the bounded repair turns, and the user
gate — is executable on shipped syntax today; what is not yet executable is the
workflow spine around it.

The exercise succeeds when:

1. Each manually invoked stage declares its props, records named artifact
   versions, and returns.
2. The planner completes the technical interview and produces an implementor
   handoff.
3. The user validates the handoff.
4. The implementor returns a repository-grounded plan that confirms, refutes, or
   amends the planner's theory.
5. The planner returns a verdict with evidence, a focused revision prompt on
   failure, and explicit user decisions when needed.
6. The loop reaches a user-authorized shared plan before implementation.
7. The run creates the workflow-owned worktree from its pinned source revision
   before discovery; implementation changes only that worktree and records
   validation evidence.
8. The planner reviews the resulting pull request, and implementation and
   review repeat when the verdict fails.
9. The user decides whether to accept the completed change.
10. The participants record every hidden-state dependency or optional file
    export encountered during the exercise.
11. The completed artifact versions remain reachable through sidecar Git history
   without appearing in the main source tree.
12. Those observations determine the smallest useful runtime implementation
   rather than a speculative complete orchestration system.

## Technical questions

### Settled

These were open when this document was written and have since been answered by
shipped behavior. They are recorded because the answers constrain what remains.

1. **How does a component return a structured value later components consume
   without prose parsing?** A component declaring `returns` renders nothing,
   holds one direct top-level `<Return>`, requires `as`, and binds one JSON
   value validated against a clone of what it produced. A registered function
   component that declares no `returns` binds its return by reference instead.
2. **Which repository reads and writes belong in `<File>`, and how are writes
   confined?** Self-closing reads and renders exact content; the content form
   atomically replaces the target and renders nothing. Confinement is lexical
   path arithmetic against `Env.cwd` before any filesystem call, re-checked
   against resolved symlinks immediately before the write.
3. **How does `<Elicit>` present document-defined options and bind a validated
   response without assuming decision policy?** The author's schema defines
   every available response; there is no built-in approve, decline, or cancel,
   and no `mode`, `provider`, or `uiSchema` prop. The schema compiles, the
   content expands, the provider answers, and core validates that answer
   against the same compiled schema. `<Answers>` supplies answers from the
   document without choosing a transport.
4. **How do `<Parse>` and `<SafeParse>` bind values and report errors without
   conflating them with component output?** Both require `schema` and `as` and
   render nothing. `<SafeParse>` absorbs JSON syntax and schema-validation
   failures and nothing else, so an unusable schema and a child execution
   failure both still fail.
5. **What `<Loop>`, `<If><Else>`, and `<Break>` semantics repeat stages without
   hiding why they stopped?** `<Loop>` requires `max`, opens no binding scope,
   records every iteration it enters, and writes one terminal `break`,
   `exhausted`, or `error` outcome that a stale replay cannot contradict.
   Reaching `max` completes normally; whether that means success is the
   document's own `<If>` to write.
6. **How does `<Glob>` define ordering, duplicate removal, symlink traversal,
   and confinement?** Relative `/`-separated paths, deduplicated, sorted
   lexically by code point; directories and symlinks are never results, which
   is what keeps traversal inside `Env.cwd`.
7. **How is the contextual working directory inherited?** `Env.cwd` is
   installed by a component for its content and read by files, globs,
   processes, daemons, and agents without any of them being handed a path.
8. **What happens to a stage whose agent returns unusable output?** The stage
   fails. Documentation runs under the `throw` error mode and an `<Output>`
   region under `output`, so the final `<Parse>` ends the run rather than
   binding malformed data; a failing region keeps only what it had already
   rendered.

### Open

The exercise must resolve enough of these to implement one vertical slice:

1. How does `<Worktree>` choose an idempotent identity, branch name, location,
   and cleanup policy from the pinned source revision the run already recorded
   (#293)?
2. Which permission policies distinguish planner investigation from implementor
   modification (#302)?
3. What state makes environmental operations safe to repeat or resume after
   interruption, including an effect recorded inside an ephemeral environment
   the current run did not create (#218)?
4. Which pull-request and issue operations belong in the first local experiment
   and which can follow after plan convergence works (#295, #296, #297)?
5. Which host sandbox can enforce the first experiment's filesystem, process,
   environment, and network policy, given that traversal confinement alone does
   not survive concurrent filesystem mutation (#227)?
6. How does a later invocation select and resume the same workflow run and
   stage without hidden transcript state (#298)?
7. What does a planning loop that reaches `max` without a passing verdict do —
   return the failing plan, fail the stage, or return to the user (#290)? An
   exhausted loop is not a failure and produces no diagnostic, so the answer is
   the document's policy to state, and it is not stated yet.

The first implementation need not answer every question. It establishes one
observable, testable path and leaves explicit follow-up issues for the rest.
