# Adversarial Implementation Workflow

- **Status:** Design exploration
- **Audience:** Maintainers and contributors

This document describes an experimental workflow for developing software with a
user, a planner agent, and an implementor agent. It captures the current design
well enough to exercise the workflow and discover which Executable.md
capabilities it needs. It does not define an implemented runtime contract.

The compact workflow map and its stage-level details live in
[the adversarial implementation workflow directory](../workflows/adversarial-implementation/workflow.md).

The executable sketch is organized around a compact
[workflow](../workflows/adversarial-implementation/workflow.md), with stage and
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

An authored `<UserGate>` component asks its supplied agent whether the next
transition contains a material choice. It involves the user when one exists or
when the agent is unsure. The current workflow supplies the planner, but the
component does not encode that role. It may determine that user involvement is
unnecessary, but only the user resolves a material choice.

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
explicit input artifacts, writes explicit result artifacts, and returns. The
user inspects the result and manually starts the next stage.

This manual boundary lets the exercise test the interview, handoff, plan,
review, decision, and revision contracts without first implementing a resident
process, file watcher, suspension protocol, or resumable resource scope.

The automated form treats script execution as a loop. An iteration stops on the
first applicable signal in this priority order:

1. The iteration reaches its defined completion.
2. A configured file is created or updated in a configured directory.
3. The user provides direct input.

The manual exercise records where each signal would have been used, but it does
not implement their detection or arbitration. In particular, runtime user input
waits for the Effection ecosystem's terminal user-interface tooling to mature.
The user supplies decisions between manually invoked stages in the meantime.

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
validation errors. A bounded loop uses nested `<If><Else>` control flow to show
any correction prompt explicitly in the producing agent's session. Correction
turns receive the candidate, validation errors, and schema; they do not run
tools, modify files, or perform additional analysis. A final `<Parse>` fails the
stage if the candidate remains invalid.

Parsing and validation are provider-neutral core behavior. ACP supplies an
agent provider but does not own parsing or hidden repair behavior. The workflow
does not use named schema strings or a `<Prompt schema>` prop.

## Workflow-owned development assets

The workflow owns worktrees, working directories, captured handoffs, plans,
feedback, decisions, branches, issues, and pull requests. An agent does not own
an asset merely because its process created it.

Deterministic components provide and pass those assets:

- `<Worktree>` creates or resolves a workspace and sets `Env.cwd` while
  rendering its children.
- `<Glob>` resolves explicit include and exclude patterns against `Env.cwd`
  into a deterministic list of normalized relative paths.
- A self-closing `<File>` reads and renders exact repository content. Its
  content-writing form is used for source changes, explicit exports, or
  external tools that require a path, not as the default agent handoff.
- `<PullRequest>` creates or resolves the pull request for a branch and returns
  its identity and state.

These names illustrate the intended authoring model; they are not implemented
syntax.

Each environmental operation declares its inputs and preconditions, reconciles
existing state, returns a structured handle, and records its observed effects.
Rerunning a pull-request operation resolves the existing pull request rather
than creating a duplicate.

Nested agent prompts receive required handoffs, plans, reviews, decisions,
commit identities, and pull-request metadata as exact content. Repository
evidence remains available through paths and read tools for selective
investigation. The workflow does not depend on a user copying output between
agent transcripts or asking an agent to locate and read another agent's file.

### Lab artifact history

Handoffs, plans, reviews, user decisions, and execution events live in a
sidecar Git history rooted at `refs/xmd/runs`. They are Git objects in the same
repository, but they do not appear in the source tree or the history of the
main source branch.

Each run records the source commit it investigated along with its artifact
contents and provenance. The sidecar ref keeps the objects reachable, and the
workflow pushes and fetches it explicitly because ordinary branch refspecs do
not imply transport of custom refs.

Captured results are immutable artifact versions keyed by stable component and
loop-iteration identity. Resuming a named run restores those values and renders
required content directly into later prompts. A generated file is an optional
export, not canonical run state. Reading such a file does not inherently save
tokens because its contents still enter model context.

`<RunHistory>` creates or resolves the stable run identity and installs it
through a contextual Run API. Worktrees, decisions, pull requests, and issues
consume that identity internally. The workflow author does not pass it through
component props; the API exposes it only when authoring logic genuinely needs
the identity.

Run history snapshots are automatic. A completed manual execution, completed
loop iteration, terminal success, failure, or cancellation records the observed
inputs, artifacts, decisions, effects, outcome, and stop reason. Authors do not
repeat those paths in an explicit checkpoint.

The first exercise creates and reads this history with ordinary Git commands.
It does not require an Executable.md component for artifact storage. Content is
screened for credentials and other data that must not become durable before it
is written to the history.

### Experiment isolation

The run resolves and records its source revision, then creates the worktree
before discovery. Planner discovery, handoff validation, implementor planning,
implementation, and review use the same pinned filesystem even if the base
branch moves.

A worktree isolates experimental Git state from the user's current checkout,
but it is not a security boundary. A supervised manual exercise combines that
disposable worktree, the narrowest available agent permission policy, a
deliberately limited task, and explicit user approval before durable or remote
effects.

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
The user triggers each stage manually within a named run. `<RunHistory>`
restores captured values and the workflow renders required content directly
into later prompts. Generated artifacts do not appear in the repository or
worktree unless the user explicitly exports them.

The exercise succeeds when:

1. Each manually invoked stage declares its inputs, records named results in
   run history, and returns.
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
11. The completed artifacts remain reachable through the sidecar Git history
   without appearing in the main source tree.
12. Those observations determine the smallest useful runtime implementation
   rather than a speculative complete orchestration system.

## Technical questions for the first exercise

The exercise must resolve enough of these questions to implement one vertical
slice:

1. How does a component return a structured asset handle that later components
   can consume without prose parsing?
2. How does `<Worktree>` choose an idempotent identity, branch name, location,
   and cleanup policy from the source revision already pinned by the run?
3. How does a worktree set the contextual working directory inherited by agent,
   file, process, and Git operations?
4. Which repository reads, source writes, explicit exports, and path-requiring
   tool operations belong in the first `<File>` component, and how are writes
   constrained to the provided workspace?
5. What assessment does `<UserGate>` require from its supplied agent, and how
   does the lower-level `<Elicit>` runtime primitive present document-defined
   options and bind a validated response without assuming decision policy?
6. How do `<Parse>` and `<SafeParse>` bind validated JSON values and report
   syntax and schema errors without conflating them with component output?
7. What `<Loop>`, nested `<If><Else>`, and `<Break>` semantics repeat plan,
   review, and correction stages without hiding the reason they stopped?
8. Which permission policies distinguish planner investigation from implementor
   modification?
9. What state makes environmental operations safe to repeat or resume after
   interruption?
10. Which pull-request and issue operations belong in the first local experiment
    and which can follow after plan convergence works?
11. Which existing host sandbox can enforce the first experiment's filesystem,
    process, environment, and network policy?
12. How does `<Glob>` define ordering, duplicate removal, ignored paths,
    symlink traversal, and workspace confinement?

The first implementation need not answer every question. It establishes one
observable, testable path and leaves explicit follow-up issues for the rest.
