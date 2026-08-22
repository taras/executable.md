# Adversarial Implementation Workflow

- **Status:** Living end-goal target
- **Audience:** Maintainers and contributors

This document describes a workflow for developing software with a user, a
planner agent, and an implementor agent. It is the target the runtime is being
built toward, and it is kept current as capabilities land: a settled contract is
described in the present tense, and a capability that does not exist yet says
so with the issue that would supply it. Sections marked as not implemented
define what must be built, not what the runtime does today.

The executable sketch is organized around a compact
[entry document](../workflows/adversarial-implementation/start.md), with stage and
runtime details in adjacent Markdown files. `architecture.md` and the
[workflow Workspace specification](./workflow-workspace-spec.md) own the
implementation invariants and the observable `xmd workflow` contract; this
document owns the roles, the authority boundaries, and the review and deferral
contracts the workflow is built to satisfy.

The dependency map is [#218](https://github.com/taras/executable.md/issues/218),
which orders every capability this target still needs.

## Purpose

The workflow helps a user turn a design conversation into a sequence of
reviewable, validated changes without making hidden agent transcripts the source
of truth.

The planner and implementor are equally capable of analysis. Their roles create
useful opposition:

- The planner interviews the user, constructs a theory of implementation, and
  challenges plans and implementations.
- The implementor investigates the repository, validates the planner's theory,
  proposes a concrete implementation plan, and then proposes the change itself
  as executable source rather than performing it.
- The user makes final decisions about behavior, scope, architecture, risk,
  sequencing, and lasting constraints.

The agents converge by exchanging evidence. Neither agent wins a disagreement
by role or authority.

An authored `<UserCheckpoint>` component asks its supplied agent whether the
next transition contains a material choice. It involves the user when one
exists or when the agent is unsure. The current workflow supplies the planner,
but the component does not encode that role. It may determine that user
involvement is unnecessary, but only the user resolves a material choice.

That authority controls execution rather than describing it. A checkpoint binds
a schema-validated decision, and every material transition is gated on it:
`proceed: false` never advances the workflow. A declined handoff does not start
planning; a declined authorization does not start implementation; a declined
review neither revises, nor creates the deferred issues it proposed, nor
accepts; a declined acceptance finishes as rejected.

A decision resolved inside a stage is gated the same way, because the stage
returns it. The caller reads the decision together with that stage's verdict —
approval *and* a passing review — so a stage cannot approve its own advancement.
A stage returns those two sources and nothing derived from them: a precomputed
flag would be a second copy of the same answer that no schema could hold to
agreement with its sources. The same pair distinguishes a decline from a review
that reached its bound still failing, and neither advances. That pair is also
what makes exhaustion a distinct outcome without a separate label, which is what
#290 settled: an exhausted loop is neither convergence nor ordinary successful
completion, it starts no implementation and no later durable effect, and it asks
the user for direction rather than answering on the stage's own account. A
a composed workflow is meant to turn that request into a durable suspension. The
substrate for one is shipped — `suspendFor()` waits, gives the executor lock
back, and a typed answer can be delivered to the waiting run (#367, #300) — but
it is an Api operation, not something this Markdown calls: nothing here converts
a checkpoint into a suspension. So exhaustion asks in the report today, and
resume never reads exhaustion, silence, or an unchanged verdict as approval.

`proceed: true` authorizes the exact transition and effects the checkpoint
assessed, and nothing more. The rule binds the material as much as the decision:
whatever an approval sets in motion has to appear in what the user assessed, in
its original form. A review checkpoint therefore shows the revision prompt that
would reach the implementor and the evidence attached to every finding that would
become an issue — not a summary of either, since approving instructions nobody
read is the same authority leak as not asking.

Free-text fields in a decision record the user's reasoning; nothing reads them to
amend what runs, because an effect that has already executed cannot be amended by
prose. This is why durable effects follow their approval rather than preceding
it — the deferred issues a review proposes are created inside the approved path,
after the checkpoint.

A checkpoint that found no material choice produces an explicit `proceed: true`
recording why, so a transition never advances because a decision was missing.

Stopping *at* the boundary is a durable suspension rather than a construct: a
checkpoint that reaches a person should record its pending request and the
Workspace frontier, give the executor lock back, and report the run ID and stop
reason, so that neither the process nor the Agent sessions need to stay alive
until `xmd workflow resume` continues there.

Every piece of that is shipped. `start` and `resume` (#366); `status` reporting
a stopped run's retained status and stop reason without advancing it (#460); the
single-executor ownership and atomic transitions owned by the executor lock
(#466); `suspendFor()`, which suspends a run durably and releases its lock
(#367); and typed delivery of an answer to a waiting run (#300).

What is missing is the join, not the parts. `suspendFor()` is an Api operation a
host or component calls — there is no v1 Markdown element that spells it, and a
suspension is a different thing from `<Elicit>`, which asks a question inside the
execution that is already running. This workflow contains no component or
middleware that turns its `<Elicit>` calls into `suspendFor()`, so its
checkpoints do not release the executor today. Consuming that substrate belongs
to #301's supervised composition. `<Stage>` is not the answer: it was
rejected as architecture, because the root document is the workflow and a durable
run may continue through several document executions without inventing
subdivisions between them (#298, closed).

## Smallest complete path

User and planner discuss the change
  → Planner writes an implementor handoff
  → User validates the handoff when discovery was required
  → Implementor validates the theory and writes a plan
  → Planner reviews the plan
  → Implementor revises or the user resolves remaining decisions
  → User authorizes the shared plan
  → Implementor proposes the change as XMD; XMD performs it
  → XMD stages, commits, and pushes, then opens the pull request
  → Planner reviews the pull request
  → Review and revision repeat until the change is accepted

Implementation does not begin merely because the planner produced a handoff.
The handoff is a theory for the implementor to test, not an implementation plan
to follow unquestioningly.

The implementor never writes to the repository itself. Agents are read-only
under a workflow run, so the change reaches the Workspace as constrained
generated XMD, and staging, committing, pushing, and pull-request creation are
separate deterministic effects the document performs. **Agents inspect; XMD
mutates.**

### Two execution environments

The command selects the environment; the document describes the procedure.

`xmd run` executes against the caller's current environment and promises no
restoration. `xmd workflow start` creates a workflow run with one implicit root
Workspace, streams the document's output in the foreground, retains the filtered
journal and the results of the commands it ran, and returns when execution
completes, fails, or is interrupted. `xmd workflow resume <run-id>` continues
from the journal frontier under the retained definition and props: completed
durable effects restore their recorded results and partial work continues. Both
are shipped (#366) on the Deno entrypoint and the compiled binary. The same
declarative components work in both; durability comes from the host rather than
from a second spelling of `<File>` or `<Git.Commit>`.

What that root Workspace supplies today is the document's filesystem, and only
that. A run's `<File>` and `<Glob>` operations resolve inside the run's own
transactional filesystem: the repository, worktree and lexical working directory
are composed by the workflow host (#293, shipped), while the Agent capabilities
the stages use are still #302's. The definition is pinned to one committed Git
object and a run passes no generic repository component search path — a root
reaches its stages by declaring them instead.

That declaration is a **component bundle**, and it is shipped (#493, delivering
#301's component-bundle slice). A root names its authored stages in its own
frontmatter; `start` and `resume` resolve exactly those names from the blobs the
pinned commit holds. Each normalizes to a canonical repository-relative path and
the blob's own object ID, and those entries participate in workflow-definition
identity and retained-history admission — so a resume or a replay reconstructs
the component from its retained source, a mutable checkout beside the definition
substitutes nothing, and an undeclared name resolves to nothing at all. Ordinary
`xmd run` resolution is unchanged.

What #301 still owes is the supervised composition: scheduling the loop and
continuing it unattended. Reaching the stage names is not running the workflow.

The stages that run today therefore run under `xmd run`, in one document
execution and one existing working directory, with the user inspecting each
result and starting the next stage. That manual boundary lets the exercise test
the interview, handoff, plan, review, decision, and revision contracts while the
retained environment around them is completed.

The automated form treats execution as a loop. An iteration stops on the first
applicable signal in this priority order:

1. The iteration reaches its defined completion.
2. A durable signal the run is waiting on arrives.
3. The user provides direct input.

Stop arbitration is not implemented (#300), and premature watcher semantics are
deliberately excluded from it. The manual exercise records where each signal
would have been used without detecting or prioritizing them.

Signal 3 has a shipped in-run form. `<Elicit>` asks a person a schema-validated
question during execution and binds the validated answer, and `xmd run` composes
the WebForm provider so that question opens a loopback browser form. Under
`xmd workflow` that same question is still `<Elicit>`, and the same WebForm
provider is installed — so an unanswered one opens a loopback form and the run
blocks on it, staying `running`. It publishes no validated answer and no
suspension request, never settles `suspended`, and never gives the executor lock
back. An authored `<Answers>` region answers it without any of that. A durable
suspension is a different mechanism, and its
substrate is shipped: `suspendFor()` waits and gives the executor lock back
(#367), the lock's ownership decides who may continue (#466), and a typed answer
can be delivered to a waiting run (#300). None of that is reached from Markdown
here — `suspendFor()` is an Api operation with no v1 element spelling it, and
this workflow installs nothing that converts an `<Elicit>` into one. Delivery
also executes nothing: it records the answer, and resuming stays an explicit act
nobody schedules.

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

A pull-request review needs the pull request's complete current state, and the
planner cannot fetch it: agent network access is denied. Whatever the prompt does
not render is invisible to the review. The prompt therefore names the revision
under review — the change at the head identity against the base — and renders the
source that performed it, the implementor's report, and the pull request's
identity. A verdict describes that head alone, and a moved head requires a fresh
review.

`<PullRequest>`'s result is deliberately minimal: filtered Repository identity,
stable provider identity, number, URL, open state, head SHA and base SHA (#295,
shipped). Existing reviews,
comments and check results are separate reads rather than fields on a creation
result that would otherwise claim to stay fresh against a remote that keeps
changing. **That read is `<Fetch>`'s** (#456, shipped): a document reads over
HTTP and retains what it read, so a network-denied reviewer can be handed a pull
request's current state without the Agent ever reaching the network. The
requirement it must satisfy is unchanged: the reviewer receives every existing
review with its body, every comment, and every check result, iterated rather
than stringified — a review that cannot see a failing check or an existing
objection is not adversarial, it is uninformed. No stage writes those fetches
yet, and admitting `<Fetch>` inside generated XMD remains #369's.

The user's checkpoint carries the same evidence. An existing objection reaches
the person approving the change in its own words, not only as the planner
summarized it — a reviewer's own text is what a later reader needs to judge
whether the objection was answered.

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

A stage that only produces material for the next prompt is a text component:
`InstructionFiles` and `Discovery` render their result and a caller's `as` binds
that text. A stage that resolves a user decision inside itself declares
`returns` instead. `Planning` and `Implementation` each run a review loop that
asks the user a question, so each returns its prose, its parsed verdict's fields,
and the complete `UserDecision` it resolved — the sources its caller gates on,
and nothing derived from them. `<UserCheckpoint>` does the same for a single
decision.

The rule is about where authority lives. A controller that resolves a decision
and returns only a rendering of it has discarded the thing its caller needs: the
caller would go on to ask the next question regardless, and could report a change
accepted whose review the user rejected. Control state crosses a component
boundary as data or it does not cross at all.

### A stage fails rather than returning a half-record

The two component kinds fail differently, and neither can hand a caller a
half-record. Whatever they hand back, the workflow root is where an uncaught
failure is settled, and a text root settles it: the fail-capable `output` mode is
installed for the root's whole body, by every text root and by every `<Output>`
region alike, so an undecided failure no printing boundary handled ends the
document execution whether or not the root declares `<Output>` (#453, shipped).
`<Output>` selects which regions render and buffers a root that declares one; it
decides nothing about whether a failure counts. Printing and continuing is asked
for with `<PrintErrors>`, and this workflow writes none.

A **text component** is split by its `<Output>` boundary: the region inside runs
under the `output` error mode, everything outside is documentation and runs
under `throw`. The two here sit on opposite sides of that line, and they fail
differently as a result.

`Discovery` runs its prompt in documentation and renders only the captured
result. A failed prompt is raised there — `throwOnError` is what raises it — and
`throw` ends the document execution.

`InstructionFiles` takes a longer route to the same end. Its `<Each>` and
`<File>` reads *are* its `<Output>` region, and `<File>` prints its own read
failures rather than propagating them, so an unreadable instruction file starts
as a component-owned printed error that the region's `output` mode never has to
decide. What the stage then hands back is a body holding that printed error — and
the binding rule refuses it. `InstructionFiles as="instructions"` binds nothing,
and the refusal is raised at the invocation, in the workflow root's own body.

A text root is fail-capable, so that is where it ends. The refusal is the run's
outcome: `Discovery` never starts, no later stage starts, `xmd run` exits
nonzero, and a replay reports the same determined failure (#453, shipped). What
the root had already rendered still reaches the output stream. So the two stages
differ in where the failure is decided, not in whether it is fatal — an
unreadable instruction file ends this workflow exactly as a failed discovery
prompt does.

A **value component** declares `returns`, so it renders nothing and cannot
contain `<Output>` at all — that would be a structural error. Its entire body
runs fail-fast, and a failure binds nothing: there is no partially validated
return for a caller to gate on. `Planning`, `Implementation`, and
`UserCheckpoint` are value components.

The two error modes differ in what a printing boundary may do about a failure: a
`<PrintErrors>` region can print an `output` decision instead of failing, and
`throw` is the one mode it cannot replace — a printed error in documentation is
one nobody can read. Neither rescues a stage here. That is what makes each
stage's final `<Parse>` a gate: malformed agent output cannot reach control flow
or a deterministic effect.

A failing region keeps only what it had already rendered. That partial text
reaches the output stream; nothing after the failure does. Continuing after a
failure is always explicit — a bounded repair turn the document shows, not
recovery the engine performs on the author's behalf.

Which region decides a failure follows from where the content was written, not
from where it ran. Content a caller projects into a component keeps the error
mode of the region the element sits in. A component's `printErrors(fn)`
declaration speaks for the component's own work and never for the caller's text,
so a projected-content failure the component does not recover from passes
outward wherever that caller site does not print, and what the projection had
already rendered belongs to the caller's region and reaches its output before
the failure. Nothing is rendered twice: a component that recovers, or that
returns, owns that text and hands over none of it (#446). A stage that wanted to
survive a failed region asks for that at the scope it means, with
`<PrintErrors>`.

Printing an `output` decision is settled contract that the engine has not built
yet: an outer `<PrintErrors>` does not print a failure a callee's `<Output>`
region already decided, and ends the document execution instead (#327). That
limitation belongs to the printing boundary alone. It is distinct from the
ownership rule above, and distinct from root settlement, which decides an
*uncaught* failure and is built. It remains open, and no stage depends on it
today.

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

The composition components are built and registered by the workflow host
(#293, shipped); the durable Git and forge effects below them are not. Both are
explicit composition rather than one implicit workspace:

- `<Repository>` authorizes a Git locator, resolves an optional base once, pins
  that commit, and creates the named primary checkout inside the run's Workspace.
  A self-closing `<Worktree … as>` adds a named linked checkout on its own branch,
  creating or restoring it, and binds its Workspace-relative path (#293). Names
  are stable component identity, not lookup keys into hidden configuration: a
  locator and a base are ordinary root props or expressions. Two repositories are
  two `<Repository>` elements, and no transaction spans them.
- Binding a checkout path and running work under it are separate steps, and that
  is settled rather than stylistic. A generic component invocation written with
  `as=` is an ordinary private capture, and `<Repository>` and `<Worktree>`
  receive no exception to it, so a lexical `<Worktree … as>…</Worktree>` cannot
  both bind the path and render its children — it would capture them. A workflow
  that needs both composes the self-closing form with a lexical
  `<Dir path={…}>` inside the same `<Repository>`.
- `<Dir>` is lexical cwd and nothing else: it establishes a bound path as cwd for
  its children, renders them normally, and restores the enclosing cwd when it
  closes. It tells an Agent nothing: a workflow Agent is given no directory at
  all (#302), so cwd is XMD's own and never an Agent's. All three —
  `<Repository>`, `<Worktree>` and `<Dir>` — are registered by
  `@executablemd/workflow/composition`, so they resolve under a workflow run and
  under no other host: plain `xmd run` composes no workflow and reports them
  unresolved, which says which host ran the document rather than whether the
  component exists.
- `<Git.Switch>`, `<Git.Add>` and staged-only `<Git.Commit>` operate on the
  contextual checkout as Workspace-local durable effects (#294). `<Git.Push />`
  is explicit and separate (#495, shipped): it publishes the selected checkout's
  exact current named branch and commit to the same branch at canonical
  `origin`, with no props, no result, nothing rendered, no force-push, no
  upstream change and no implicit stage or commit. `<PullRequest>` requires that
  Push's own matching successful evidence rather than performing a hidden push
  (#295, shipped).
- `<IssueTracker>` names the tracker or project new issues belong in, and a
  paired `<Issue title=… as=…>` files an approved deferred finding with its
  description as the element body, binding `{ url }` (#296, shipped by #516).
  The authored tracker URL selects a target and grants no authority: the host
  installs an adapter-private ceiling beside its credentials, and a target
  outside it fails before any provider observes anything. `IssueApi` is its own
  boundary rather than a Git one.

Authentication for all of them is ambient host input, acquired per provider
invocation (#532, shipped): HTTP Git uses the invoking user's credential-helper
chain for the exact locator, SSH uses the selected ambient agent and known-host
policy, and GitHub API calls read `GH_TOKEN`, then `GITHUB_TOKEN`, then
`gh auth token --hostname github.com`. It is never a public credential prop, a
workflow secret schema, a copied credential, a retained value, Workspace
material, a command argument, a URL, a journal field, output, or a diagnostic
cause. Replay acquires no credentials; an interrupted effect reacquires current
host authentication and reconciles through its provider contract. Agents receive
neither credentials nor direct network authority.

Each environmental operation declares its inputs and preconditions, reconciles
existing state, returns a structured result, and records its observed effects. A
result is a structure, never a string standing in for one: `<PullRequest>`
resolves filtered Repository identity, stable provider identity, number, URL,
open state, head SHA and base SHA, and a stage that declared any of that as text
would fail its own return validation after the effect had already happened.
Rerunning a pull-request operation resolves the existing pull request rather than
creating a duplicate, through the
effect's natural key as well as its stable identity (#297).

`<Git.Commit>` journals reconciliation evidence — repository and worktree
identity, branch, commit and parent SHAs, tree SHA, staged paths, message
evidence — rather than Git object contents. Replaying a completed commit creates
no second commit, and replaying a completed push performs no remote mutation.
The first local provider is expected to use native Git for the most faithful
checkout, worktree and object-cache behavior; a browser provider may implement
the same contract differently, including emulating named worktrees as separate
retained checkouts, without changing what a document writes (#293, #410).
Initial checkout speed is provider-owned acceleration: a host-local mirror or
object cache may change how fast a clone is, never what the run records or how it
replays.

Nested agent prompts receive required handoffs, plans, reviews, decisions,
commit identities, and pull-request metadata as exact content. Repository
evidence remains available through paths and read tools for selective
investigation. The workflow does not depend on a user copying output between
agent transcripts or asking an agent to locate and read another agent's file.

### Retained run state

Retention exists. A workflow run owns one SQLite database holding its filtered
journal and effect results, versioned Workspace roots and content, Repository and
Worktree metadata, and Agent-session mappings, and it is found by public run ID
alone (#291, shipped). Every Workspace-local expansion publishes its mutation, the
resulting logical Workspace root, and its filtered journal result in one
transaction — all three commit or none does (#365, shipped). Alongside the journal
the run retains its immutable identity, one of six statuses, a nullable stop
reason, replaceable retrieval metadata, and one document-execution record per
start and per resume.

There is no sidecar Git history. Earlier revisions of this document put artifact
versions in Git objects under `refs/xmd/runs`; run state lives in the run's own
database instead, which is why a run survives independently of any repository it
touched and why deleting a run never claims to undo a push.

Co-location does not make arbitrary filesystem content journal or training data.
Journal events reach storage already filtered by the pre-persistence secret gate,
and storage adds no second policy: a rejected gate leaves nothing behind. Making
that gate default-on for execution, with its CLI opt-out and warning, is #199.

`JournalProvenance` is what makes retained history evidence rather than merely
storage. It is a non-operational, equality-only witness that a live publication
stream descends from the exact journal backend a provider selected for one
workflow run. It grants no append, read, execution, publication, or reconciliation
capability, and it is meaningful only because the provider retains the witness it
established and later requires exact equality. The generic pre-persistence guard
preserves nothing; the trusted secret-filter wrapping site preserves provenance
explicitly, so a filtered journal — including one wrapped more than once — still
carries the witness its source carried. Another run's journal, an in-memory
stream, a copied property, an ordinary guard, or a look-alike is refused before
any mutation or publication. For a review workflow that is the difference between
"the history says the pull request was created" and "this history is the one this
run wrote."

Every committed journal event references the logical Workspace root current when
it was written, and only committed event boundaries are checkpoints — which is
what makes an event selectable for a compatible history fork later (#368).

A command a stage runs is retained on the same terms. Routing, retention, and
failure are three separate decisions. An ordinary executable block forwards
stdout and stderr live as the run receives them and renders neither again at
completion; what a reader sees is the document's own display policy. What the run
*keeps* is the host path's decision, and `xmd workflow start` and
`xmd workflow resume` retain both channels received at the per-exec boundary
whatever that display policy was, because a resumed procedure reads back what a
command printed rather than running it again to find out. `xmd run` retains a
command's channels only when its diagnostic journal is requested. Retained text
is what reached the run's boundary after the host's own stdio middleware, and it
crosses the pre-persistence secret gate like any other journaled field.
`Process.join()` may settle before the output pumps finish, so output written as
they settle may not reach that boundary at all; effectionx #244 owns the stronger
guarantee, and nothing here claims pump-complete retention until it is
integrated.

A nonzero exit is the third decision, and a document may take it as data instead.
`exec as="name"` displays neither channel, renders nothing, and binds a fresh
mutable `{ exitCode, stdout, stderr }`, so a nonzero exit is ordinary control-flow
data rather than a raised checked failure. The bound value is the settled outcome
built-in exec obtained: only the built-in `timeout` and the built-in `exec` may
compose a bound command, authorized by the exact built-ins the execution
installed rather than by the word the block wrote, and public modifier middleware
may observe or refuse but can neither remove those authorization facts nor
manufacture or replace the outcome. Binding is not retention: the buffers a
binding needs belong to the expansion, and what the run keeps durably stays the
host's decision.

Most of what a stage produces is already journaled. `<Loop>` records every
iteration it enters and one terminal `break`, `exhausted`, or `error` outcome,
and refuses a replay whose stored outcome or iteration count disagrees with what
this execution reached — there is no `cancelled` loop outcome, because run-level
cancellation and stop reasons are retained run state rather than loop state. Each
`<Prompt>` is one durable operation carrying its identity, input, agent and
session, terminal status, text, and structured failure. `<Elicit>` journals its
validated answer keyed by a fingerprint of the compiled schema and the rendered
message, and refuses a recorded answer whose question does not match.

`xmd workflow history <run-id> [--json]` is how a person reads that back: stable
public event IDs with each event's operation, authored source position, result or
normalized error, and Workspace root. It is shipped, with
`xmd workflow status <run-id> [--json]` and
`xmd workflow list [--status=<status>] [--json]`, as #367's first slice (#460).

Each answers from an immutable lifecycle snapshot, and what it refuses to do is
the contract: no execution handle and no executor lease, no replay and no
advancement, no Workspace attachment and no root materialization, no document
import, no Agent, process or external provider, and no reconciliation or append.
History reads already-filtered retained protocol events, so it exposes no value
the security policy has not already seen, and the authored source position it
reports is descriptive evidence about an event rather than identity.

Inspection survives a crashed host (#521, shipped). The ordinary reading is of
the retained snapshot. The single condition it cannot get past is SQLite's exact
`SQLITE_READONLY_ROLLBACK`, a hot rollback journal a lost host left behind; that
falls through to recovery, which copies the database and journal under recovery
coordination and lets SQLite roll the journal back into the private copy. The
authoritative crashed source is left byte-identical for the write-capable owner
whose job recovery actually is. Recovery coordination grants no executor or
lifecycle authority and opens no Workspace or provider effects, and `list`
remains complete-or-error.

The authority underneath is shipped as #367's second slice (#466). The executor
lock owns every lifecycle transition, so single-executor ownership, atomic begin
and settle, cancellation and deletion are built. Cancellation never reaches into
a live document execution: meeting a live executor it refuses without mutation
and directs the caller to interrupt the foreground process, while an eligible
retained state transitions to `cancelled` under the exact lock, and a
`completed` or `failed` outcome stays authoritative.

The wait is built too: `suspendFor()` suspends a run durably and gives its
executor lock back (#367), and a typed answer can be delivered to it (#300).
What is not built is anything that reaches or acts on it — no v1 Markdown
element spells the operation, this workflow calls nothing that suspends,
delivery executes nothing, and no scheduler resumes a run. Versioned history checkpoints, compatible forks,
`history --forkable`, forkability reasons, lineage, changed-definition replay
admission and retained Workspace-root copying are shipped (#368, delivered by
#498). A fork is an explicit new run continuing one run's retained history; it
is not an Agent provider continuing a session, and nothing schedules or resumes
either.

**Still missing: who answered.** The journal records the validated decision, the
question fingerprint, and the document execution it belongs to. It does not
record the actor identity behind an elicitation response, so a decision is
attributable to a run and an expansion but not to a person. No open issue owns
that yet.

Replay is what makes a resumed stage possible: a document execution that failed
is still a complete record, and replaying it restores the output and the failure
without re-executing anything. Completed durable effects restore their recorded
results; ephemeral operations run again only to rebuild live structure. Replay
never asks current state to prove a past effect, and a completed root result
returns without expanding the document or attaching any provider — so replaying a
finished run does not reclone, recommit, or repush. Missing or corrupt
authoritative Workspace state fails explicitly rather than being silently
recreated.

Prompts therefore receive their content from restored values rather than from a
file an agent was asked to locate and read. A generated file is an optional
export, not canonical run state, and reading one does not inherently save tokens
because its contents still enter model context.

### Agent authority and generated XMD

Under `xmd workflow` an Agent is mandatorily read-only. Enforcement has two
layers: the provider permission bridge allows only read and search operations,
and the provider runs in its native read-only sandbox. There is no third layer
presenting Workspace paths as read-only filesystem views, because no Workspace
path is registered with an Agent in the first place. `<ApproveAll>`, repository
`.codex` or `.claude` configuration, and prompt content cannot exceed that host
ceiling, and a provider that cannot enforce it fails before Prompt execution
(#302).

The ceiling is therefore the host's, not the document's. There is no `<Sandbox>`
component and no document prop that grants an Agent write access; earlier
revisions of this document declared readable roots, writable roots, environment,
process, and network policy as markup, and that authority moved to where a
document cannot widen it. The ceiling goes further than write access. A workflow
Agent receives no Workspace checkout and no read-only materialization of one, no
Workspace or host path as its working directory, no `additionalDirectories` over
ACP, and no component that registers a directory with its session (#302). What
it may reason over is what a prompt renders into it, and repository observation
is the bounded XMD request/result loop #302 and #369 still owe.

An Agent that cannot write proposes changes instead. It returns an XMD fragment,
and a constrained evaluator parses the complete fragment before its first effect,
resolves an allowlist to pinned component identities supplied by the trusted
parent definition, refuses everything outside that set — eval and exec blocks,
imports, native execution, arbitrary JavaScript expressions — and only then
expands what it admitted (#369). Rejected syntax produces no partial effect. The
allowlist is authority rather than prompting guidance: generated source cannot
grant itself push, pull-request, or secret access by naming a component. The exact
filtered generated source is retained, so replay expands the same fragment without
asking the Agent again, and a reviewer and the user read the literal source that
performed the change.

Every file the workflow writes is consequently an ordinary durable XMD effect
with its own expansion identity, journal result, and Workspace transaction —
never a side effect of an agent process.

Underneath the allowlist sits the same division for the engine itself: canonical
core alone brings an execution or a document expansion into being and publishes
its outcome (#432, #433). Public `Execution.execute` middleware is handed an
opaque request and may inspect the options, narrow them, register an additive
completion policy, install contextual behavior, refuse by throwing, and delegate;
public `Execution.document` middleware may inspect the props, narrow or replace
them, install contextual behavior, refuse, and delegate. Whatever either returns
is ignored, so no handler can synthesize an execution, a document, an output
stream, a success, or a failure. Each request is a one-use capability belonging
to one invocation or one expansion: a reconstructed look-alike, a superseded
request, another invocation's request, and a second delegation are each refused
before any journal read, expansion, or append. The trusted preparation a workflow
run needs is installed through the host boundary instead — ahead of every public
document policy, the root import, and every authored effect — which is why
security authority, retained identity, and outcome reconciliation never trust
replaceable contextual state.

Agent network access is denied, which is why a review prompt must render
everything the reviewer has to judge rather than pointing at it.

### Experiment isolation

The run pins its Repository base once and composes named checkouts from it.
Planner discovery, handoff validation, implementor planning, implementation, and
review use the same pinned revision even if the base branch moves, and replay
does not re-query a moving branch.

A worktree isolates experimental Git state from the user's current checkout. It
is composition and isolation, not a security boundary — the security boundary is
the host's Agent ceiling and the Workspace the document's file operations resolve
inside.

`<Repository>` and `<Worktree>` are built and registered by the workflow host
(#293, shipped); the durable Git and forge effects that reach a remote, and the
bounded observation loop an Agent would use, are not (#370, #295, #296, #369,
#302). `API.Files` and its host provider are: every document file operation
routes through that provider, which confines document paths to `Env.cwd` while the
host namespace is stable. That claim is about traversal rather than about the
filesystem being stable — a directory that is real when it is read could be
replaced afterwards. A workflow run installs the transaction-bound provider
instead, and it is built: the same authored paths resolve inside the run's own
filesystem, where a document path never becomes a host path at all, and each
read, write, or search is one effect transaction. #227 stays open for the host
provider's validate-then-use race rather than for the run's namespace.

Scope cleanup releases live attachments; it does not delete run-owned state.
Every run status is retained until an explicit `xmd workflow delete`, which
reports what it removed and never claims to rewind a push, a pull request, or an
issue (#367).

### Cleanup and recovery

Resources clean up with their execution by default. Agent sessions, processes,
streams, and other ongoing effects always stop before their enclosing scope
closes.

Ownership follows the invocation, not the author. Content a caller writes and a
component only projects keeps the caller's bindings, but its live effects belong
to the component invocation and stop before that invocation cleans up its own
(#203). A daemon or a `persist` resource started inside projected content is
signalled while the component's directory still exists, and is gone once the
invocation returns. That ordering is what makes `<Worktree>` safe to build: a
process a stage starts stops before the workspace it ran in is removed, so
cleanup cannot pull the ground out from under a running effect.

Cleanup releases live attachments; it does not delete the run's Workspace. Every
run status is retained by default, so a failed, cancelled, or interrupted run
keeps its checkouts and its journal for inspection and for an eligible history
fork. Deletion or explicit cleanup reports retained dirty, unpushed, or
conflicting work and never discards it implicitly (#293, #367).

Durable published effects such as commits, issues, and pull requests remain
after temporary execution resources close, and no deletion claims to undo them.

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
The user triggers each stage manually. Required content is rendered directly into
later prompts from restored values, and generated artifacts do not appear in a
checkout unless the user explicitly exports them.

The exercise runs under `xmd run`, in one document execution and one existing
working directory. The document logic — instruction discovery, the planner
interview, plan convergence, the bounded repair turns, and the user gate — is
executable on shipped syntax today, and a workflow run can now give it both a
checkout (#293) and its stage names, which the root declares as a component
bundle resolved from the pinned commit (#493). What it cannot yet give is the
supervision: scheduling the loop and continuing it unattended remain #301's.

The exercise succeeds when:

1. Each manually invoked stage declares its props, publishes explicit results,
   and returns.
2. The planner completes the technical interview and produces an implementor
   handoff.
3. The user validates the handoff.
4. The implementor returns a repository-grounded plan that confirms, refutes, or
   amends the planner's theory.
5. The planner returns a verdict with evidence, a focused revision prompt on
   failure, and explicit user decisions when needed.
6. The loop reaches a user-authorized shared plan before implementation.
7. The run composes a named Repository and Worktree from its pinned base before
   discovery; the change reaches that worktree as admitted generated XMD rather
   than as agent writes, and validation evidence is recorded.
8. `<Git.Add>`, `<Git.Commit>`, and an explicit `<Git.Push />` precede
   `<PullRequest>`, and none of them is implied by another: the pull request
   requires the run's own matching successful Push evidence and never publishes
   anything itself.
9. The planner reviews the resulting pull request, and implementation and
   review repeat when the verdict fails.
10. The user decides whether to accept the completed change.
11. The participants record every hidden-state dependency or optional file
    export encountered during the exercise.
12. The run's filtered journal, Workspace roots, and effect results remain
    readable through the retained run rather than through any repository ref.
13. Those observations determine the smallest useful runtime implementation
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
   region under `output`, so the final `<Parse>` ends the document execution
   rather than binding malformed data; a failing region keeps only what it had
   already rendered.
9. **How does a document read a prop?** Under the `props` namespace, in
   expression props and in text alike: `agent={props.planner}` and
   `{props.instructions}`. Declaring a prop creates no bare binding
   (#305, shipped). Authored bindings — from `as`, `<Let>`, `<Each>`, `<Loop>`, `<Return>` —
   stay bare.
10. **Where may a component body project its caller's content?** Anywhere it
    writes `<Content />`, including nested inside another invocation such as a
    `<Prompt>` (#328). The stages here still take their material as declared
    props, because a stage's inputs are part of its contract and a schema
    validates them.
11. **Where does a stage's durable environment live?** In the workflow run's own
    retained store, addressed by public run ID: filtered journal and effect
    results, versioned Workspace roots and content, Repository and Worktree
    metadata, Agent-session mappings (#291). One Workspace-local expansion
    publishes its mutation, logical root, and journal result in a single
    transaction (#365).
12. **Which construct owns a stage boundary?** None. The root document is the
    workflow, and a durable run continues across document executions through
    suspension and `resume` rather than through a `<Stage>` construct (#298,
    closed as superseded).
13. **How does a later invocation select the same workflow run without hidden
    transcript state?** By public run ID alone. `xmd workflow resume <run-id>`
    reuses the run's retained definition and props rather than whatever the
    checkout holds now, and a document path locates a definition rather than
    selecting a previous run (#366).
14. **How does `<Worktree>` identify itself, and how does the composition
    replay?** Identity is the enclosing Repository's identity plus the
    `<Worktree>`'s own explicit name — which is why the Repository comes from
    lexical context rather than a prop, since a document able to name one could
    name a Repository not in scope. A self-closing `<Worktree … as>` creates or
    restores that named checkout and binds its Workspace-relative path without
    establishing cwd; the lexical `<Dir path={…}>` beneath it establishes that
    path as cwd and renders its descendants. Replay restores and verifies the
    retained creation record rather than recreating a completed checkout effect,
    missing or conflicting retained Git state fails explicitly instead of being
    reset or merged, and cleanup is explicit — it never silently discards
    retained work (#293, shipped).

### Open

The exercise must resolve enough of these to implement one vertical slice:

1. What bounded request/result loop lets an Agent observe the repository at all,
   given that it receives no checkout, no materialization, no working directory
   and no registered directory (#302, #369)?
2. What is the public spelling of the component a document writes to expand
   constrained generated XMD, and what does a *mutating* fragment's admission
   require (#369)? The evaluator itself is settled and built for observation
   (#497): complete preflight inside the admission, pinned identities, exact
   request ceilings, one retained decision, and replay held to it.
3. What state makes external effects safe to repeat or resume after
   interruption (#297)? A revision iteration reaching the *same* pull request is
   settled: the effect is an upsert over one explicit identity (#295, #500,
   #504), and #301's architecture amendment settles the composition — an
   expression prop evaluating to `undefined` is omitted before validation and
   before the durable JSON boundary, so a loop seeded with an empty object
   creates on its first iteration and updates on every later one through a
   single invocation. Omission is not built yet.
4. Which fetches does a review actually write? `<PullRequest>`'s result is
   deliberately minimal, and `<Fetch>` (#456) is how a network-denied reviewer is
   handed the rest — but no stage composes those reads yet, and the public
   component that expands a fragment carrying one stays #369's.
5. Which host mechanism closes the validate-then-use race for each supported
   runtime, now that a run-owned Workspace resolves a document path without
   producing a host path at all (#227)?
6. Which durable signals may schedule a resumption, and how is one arbitrated
   against an iteration's own completion and direct user input (#300)?
7. What records who answered an elicitation? The journal retains the validated
   decision and its question fingerprint but no actor identity, so a decision is
   attributable to a run and an expansion but not to a person. No issue owns it.

The first implementation need not answer every question. It establishes one
observable, testable path and leaves explicit follow-up issues for the rest.
