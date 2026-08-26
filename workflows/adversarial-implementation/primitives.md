# Primitive Inventory

## XMD execution foundation

XMD already supplies component expansion, root and component props, prompt
capture, agent selection, named sessions, collection iteration, scoped
permission policies, and scope-owned process and agent teardown. Every component
invocation owns a resource scope: projected content keeps its caller's bindings
but its live effects — daemons, `persist` resources, watchers — belong to the
invocation and stop before it cleans up its own, on success, failure, and
cancellation alike (#203). Its durable execution layer assigns deterministic
expansion identities, journals effects, and observes completion, failure, or
cancellation. Replay restores a recorded outcome without re-executing it, and a
document execution that failed is still a complete record: replaying it restores
the output and the failure alike. Replay determinism means the journal does not
lose the execution chain — replaying arrives at the same state, where execution
can continue.

Bringing one of those executions into being belongs to canonical core alone.
Public `Execution.execute` middleware may inspect the options, narrow them,
register an additive completion policy, install contextual behavior, refuse by
throwing, and delegate; public `Execution.document` middleware may inspect the
props, narrow or replace them, install contextual behavior, refuse, and
delegate. Each is handed an opaque request that belongs to one invocation or one
expansion and may be used once, and whatever a handler returns is ignored — so no
composed layer produces an execution, a document, an output stream, a success,
or a failure. A look-alike, a superseded request, another expansion's request,
and a second delegation are each refused before any journal read, expansion, or
append. What a run genuinely requires is installed by a trusted host through the
host boundary, ahead of all public document policy, the root import, and every
authored effect (#432, #433).

An executable block is a foreground child, and three questions about one never
answer each other. **Routing** is what a reader sees: an ordinary block forwards
stdout and stderr live as the run receives them and renders neither into the
document again at completion. **Retention** is what the run keeps, stated by the
host path that starts it rather than inferred — `xmd workflow start` and
`xmd workflow resume` retain both received channels because a resumed procedure
reads a command's output back instead of re-running it, while `xmd run` retains
them only for a diagnostic journal it was asked for. **Failure** is neither: a
nonzero exit is a checked failure that a printing boundary may report but never
excuse. A document may take that status as data instead — `exec as="name"`
displays neither channel, renders nothing, and binds a fresh mutable
`{ exitCode, stdout, stderr }`, so a nonzero exit raises nothing. Only the
built-in `timeout` and the built-in `exec` may compose a bound block, authorized
by the exact built-ins the execution installed rather than by the word the block
wrote; public modifier middleware may observe the request or refuse it, and can
neither remove those facts nor manufacture the outcome. Binding is not
retention. `Process.join()` may settle before the output pumps finish, so
nothing here claims pump-complete delivery or retention until effectionx #244 is
integrated.

Under `xmd workflow` those records are also retained and addressable. That is
the difference between an execution journal and a run someone can come back to,
and it exists now (#291, #365, #366).

## How a name resolves

Name resolution has tiers, and the first tier that answers wins:

1. **structural syntax** — the language's own constructs;
2. **a reserved registration** — a host protecting a language or security
   invariant;
3. **a repository-local file**;
4. **a registered default**, including everything core supplies; and
5. **nothing**, which is the unresolved printed error.

Two consequences govern what this workflow may rely on. A **repository
component overrides any ordinary package default**, core's own included — so
`<Elicit>`, `<Parse>`, `<Glob>`, `<File>`, `<Agent>`, `<Session>`, `<Prompt>`,
and every other registered default sits *below* a repository file of the same
name, and a repository `Elicit.md` is chosen ahead of core's. Only genuine
absence falls through to a default: a candidate that exists but cannot be read,
imported, parsed, or compiled fails where it is loaded rather than being
quietly replaced. **Structural names are reserved**, so a registration cannot
claim one and a repository file never stands in for it.

**Registration is scope-local.** `registerComponents()` makes names resolvable
for the installing scope and its descendants. A child scope may register a name
its parent already registered — that shadows, and the parent is unchanged.
Siblings and concurrent executions never see one another's registrations, and
leaving the installing scope removes them. Registering describes a component; it
runs nothing and acquires nothing, and names and schemas are validated where
they are installed rather than the first time a document writes the name. Two
registrations for one name and kind at the same scope are a configuration error
naming both origins; installation order is not a resolution mechanism. This is
the general rule that all engine state is scoped to the operation that owns it:
created inside the operation it describes, provided contextually, and torn down
with it. There is no module-scoped registry for this workflow to reach.

## How an error is decided

Every region of every document carries an error mode, set by the lexical
structure and read where an error is raised:

| Mode | An undecided error… | Installed by |
| --- | --- | --- |
| `print` | is printed into the document; execution continues | `<PrintErrors>`; `printErrors(fn)` |
| `output` | fails the document execution; `<PrintErrors>` can print instead | every text root; every `<Output>` region |
| `throw` | fails the document execution, and no printing boundary replaces it | documentation; value roots |

**Printing is asked for, and a root asks for nothing.** A text root is
fail-capable: it installs `output` for its whole body, so an uncaught, undecided
failure is the document execution's own outcome whether or not the root declares
`<Output>` (#453, shipped). `<Output>` selects which regions render and buffers a root that
declares one; it decides nothing about whether a failure counts, and a root that
declares none settles a failure on exactly the same terms. Continuing past one is
requested explicitly, with `<PrintErrors>`. `printErrors(fn)` still speaks only
for the component that declared it.

A failing region keeps what it had already rendered: that text reaches the
output stream, and nothing after the failure does. The failure is retained and a
replay reports the same determined failure without re-executing anything, and
`xmd run` exits nonzero.

Content a caller projects is read from the same table, at the row for the region
the *element* is written in. A component's `printErrors(fn)` declaration speaks
for that component's own work and never for the text a caller wrote inside it, so
a projected failure the component does not recover from passes outward wherever
the caller's region does not print, and what the projection rendered first goes
to the caller's region — once, never twice, because a component that recovers or
returns owns that text and hands over none of it (#446). Asking a component for a
directory, a parsed value, or a written file therefore never reopens a path the
caller's region closed — an `<Output>` region or the root itself.

A **text component**'s body is split by its `<Output>` boundary: the region
inside runs under `output`, everything outside is documentation and runs under
`throw`. A **value component** declares `returns` and renders nothing, so it
cannot contain `<Output>` — that is a structural error — and its entire body
runs fail-fast, binding nothing when it fails.

Either way a component returns a complete validated result or it fails; neither
kind can hand a caller a half-record. `<Retry>` and `<Result as>` would let a
document handle a failure instead of ending on it; both are defined and unbuilt.

**Missing: printing an `output` decision.** The `output` row above is the
settled contract, and the engine does not meet it yet — an outer
`<PrintErrors>` does not print a failure a callee's `<Output>` region already
decided, and ends the document execution instead ([issue
#327](https://github.com/taras/executable.md/issues/327)). That is a limitation
of the printing boundary alone. It is distinct from which region owns a
projected failure, and distinct from root settlement, which decides an *uncaught*
failure and is built. It remains open. Nothing in this workflow writes
`<PrintErrors>`, so no stage depends on it today; a stage that wanted to survive
a failed region would.

## What the workflow already writes

**Structural syntax** is the language's own. A registration cannot claim one of
these names and a repository file never stands in for it:

1. `<If>` with an optional nested `<Else>`, and `<Loop>` with `<Break>`, provide
   visible bounded control flow. `<If>` selects its branch by JavaScript
   truthiness. `<Loop>` requires `max`, opens no binding scope, and completes
   normally when it reaches that bound.
2. `<Answers>` and `<Answer>` supply elicitation responses from the document.
   `<Answers>` installs a provider around its body and answers from its
   matchers; it reads them as elements before they expand, which is why a
   registered component could not implement it.
3. `<Return>` selects a value component's return value.
4. `<Content>`, `<Output>`, `<Let>`, `<Each>`, and `<PrintErrors>` complete
   the set. `<PrintErrors>` accepts no props: it names a region, sets `print`
   for it, and turns a failure that reaches it into one printed error whose
   `cause` is the complete original failure. `throw` is the one mode it does not
   replace, so it cannot rescue a stage's documentation.

**Core defaults** ship in the compiled binary and every published package, with
no search path and no `--component-dir`. They are ordinary defaults rather than
reserved names, so a repository component may override each one:

5. `<Glob>` evaluates explicit include and exclude patterns relative to
   `Env.cwd`. It declares `returns`, so it renders nothing, must be invoked
   with `as`, and binds one `string[]` validated against a clone of what it
   produced rather than a by-reference binding: relative paths, `/`-separated
   on every platform, deduplicated, and sorted lexically by code point.
   Directories and symbolic links are never results, which is what keeps a
   search inside `Env.cwd` without judging any destination. Finding nothing is
   an empty array rather than a failure.
6. `<File>` reads or writes UTF-8 text relative to `Env.cwd`. Self-closing it
   reads and renders the file's exact content, and `as` captures that text.
   Written with content it expands its children, atomically replaces the target,
   and renders nothing at all — no output, no path, no write handle. Every
   operation goes through the contextual `API.Files` provider, and there is no
   host default: the four CLI entrypoints install the host provider, which
   confines document paths to `Env.cwd` while the host namespace is stable
   ([#227](https://github.com/taras/executable.md/issues/227)). A workflow run
   installs the transaction-bound provider instead: the same authored paths
   resolve inside the run's own filesystem, where there is no host path to escape
   from, and each read, write, or search is one effect transaction. What #227
   still owes is the host provider's validate-then-use race, not the run's
   namespace.
7. `<Parse>` renders its children, decodes the result as JSON, validates it
   against a draft-07 schema supplied as captured text or as a structured
   value, and binds the validated value through `as`. `<SafeParse>` performs
   the same deterministic work but binds either `{ ok: true, value }` or
   `{ ok: false, input, errors }`, preserving the rendered input exactly so a
   corrective prompt can quote what was said. Both require `schema` and `as`,
   render nothing, and compile the complete schema before their children
   expand. `<SafeParse>` absorbs JSON syntax and schema-validation failures and
   nothing else: an unusable schema still fails, and a child execution failure
   propagates unchanged. Validation judges the value and never edits it — no
   default is inserted, no type coerced, no undeclared property removed.
   Neither component repairs content; repair is written in Markdown where a
   reader can see it. Only references contained within the supplied schema
   resolve, and an external `$ref` fails at compilation ([issue
   #192](https://github.com/taras/executable.md/issues/192)).
8. `<Elicit>` renders its children as the request message, requires a `schema`
   that defines the exact fields and options available to the user, and binds
   the validated response through `as`. The schema compiles first, the content
   expands second, and the provider is asked third; that order is the contract.
   There is no `mode`, `provider`, or `uiSchema` prop and no built-in approve,
   decline, or cancel — the schema defines every available response, and
   cancelling execution stays an Effection lifecycle event unless the document
   models it as schema data. Where the asking happens is the host's decision,
   made through the Elicitation Api: `xmd run` composes WebForm as its current
   provider, and under `xmd workflow` the host suspends the run durably instead
   (#577); changing where the asking happens changes no Markdown. Only the
   validated
   answer is journaled, keyed by a fingerprint of the compiled schema and the
   rendered message, so a resumed execution restores it rather than asking twice
   and refuses an answer recorded against a different question.
9. `<TempDir>` establishes a fresh contextual working directory for its content
   and removes it when the content finishes, fails, or is cancelled. It is the
   shipped shape of a lexical working directory; under a workflow run that role
   belongs to `<Repository>`, `<Worktree>`, and `<Dir>`.

**Registered agent components** are defaults on the same terms.
`installAgentComponents()` registers them for the installing scope, and a
repository `Prompt.md` or `Agent.ts` outranks them:

10. `<Agent name>` and `<Session name>` pin an agent and a session onto nested
    prompts; `<Prompt>` sends one prompt and renders the reply, with `agent`,
    `session`, and `timeout` overriding the enclosing scope. `throwOnError`
    turns a failed prompt into a failure the enclosing error mode then decides;
    without it a failed prompt records its failure and returns its text, so
    nothing is raised and the stage carries on with an empty reply. Their props
    take a literal or an expression that resolves to a string, so this workflow
    selects the planner and implementor from validated root props rather than
    literals. Each prompt is one durable operation whose record carries its
    identity, input, agent and session, terminal status, text, and structured
    failure. None of them hands an Agent a directory; the workflow Agent
    boundary below is why there is none to hand.

**Props are namespaced.** A declared prop is read as `props.name` in text, in
executable-block content, in eval blocks, and in expression props alike:
`agent={props.planner}` and `{props.instructions}` are both correct, and
declaring `planner` creates no bare `{planner}` binding
([#305](https://github.com/taras/executable.md/issues/305), shipped). Authored
bindings — from `as`, `<Let>`, `<Each>`, `<Loop>`, `<Return>` — stay bare,
which is why `<Dir path={worktree}>` reads the path a self-closing `<Worktree>`
bound.

**Content projects at any depth.** `<Content />` is substituted wherever a
component body writes it, including nested inside another invocation such as a
`<Prompt>` ([#328](https://github.com/taras/executable.md/issues/328), fixed).
The stages here still take their material as declared props rather than as
projected content, because a stage's inputs are part of its contract and a
schema validates them; projection is available where a caller genuinely writes
prose into a component.

The document-level logic in `InstructionFiles`, `Discovery`, `Planning`, and
`UserCheckpoint` therefore uses shipped syntax throughout. None of them asks for
a directory: a workflow Agent is given none, so each stage reasons over what its
prompt renders. `Implementation` is the exception, and not for that reason: it invokes
`<Evaluate>`, which the run's host declares to the execution rather than
registering, and `<Git.Add>`, `<Git.Commit>`, `<Git.Push>`, `<PullRequest>`,
`<IssueTracker>` and `<Issue>`, which resolve under a workflow run where the
host registers them.

**No name in this workflow resolves to nothing.** The unresolved inventory is
empty. `<IssueTracker>` and `<Issue>` left it when #516 shipped them for #296;
`<Git.Push>` and `<PullRequest>` left it when #495, #500 and #504 shipped them;
`<Git.Switch>`, `<Git.Add>` and staged-only `<Git.Commit>` left it when #294
shipped them as Workspace-local durable effects. The Git effects sit over the
shared Git-host reconciliation #297 shipped, and the issue effects sit over
`IssueApi`, which is its own boundary rather than a Git one. `<Agent.AddDir>` is
absent for a different reason: #302 settles that a workflow Agent gets no
checkout, no materialization, no cwd of its own and no registered directory, so
it is not an implementation target this workflow is waiting on. What replaced it
is the bounded request/result loop `<Evaluate>` performs (#549, #550).

`<Repository>`, `<Worktree>` and `<Dir>` have left that list:
`@executablemd/workflow/composition` registers all three (#293, shipped), which
is what makes the composition below executable under a workflow run. Because
registration is scope-local and the workflow host installs it, plain `xmd run`
resolves none of them — evidence about the host a document ran under, never
about whether a component is built.

The composition itself is unchanged, and it is why the two forms exist. A generic component
invocation written with `as=` is an ordinary private capture — it binds its
result and contributes nothing at the call site — and `<Repository>` and
`<Worktree>` receive no exception to it. So a lexical
`<Worktree … as="worktree">…</Worktree>` cannot mean "bind the path *and* render
these children"; it would capture the flow, and the root's `<Output>` would emit
nothing. A workflow that needs both composes the two existing forms: a
self-closing `<Worktree … as="worktree" />` creates or restores the retained
checkout and binds its Workspace-relative path without establishing cwd for what
follows, and a lexical `<Dir path={worktree}>` beneath it makes that bound path
cwd for the stage flow, renders its children normally, and restores the enclosing
`<Repository>` cwd on the way out. Both sit inside the lexical `<Repository>`, so
its context is present throughout. `<Dir>` tells an Agent nothing: it establishes
cwd for XMD's own file effects, and a workflow Agent has no directory of any kind
(#302).

Everything else the workflow writes resolves: `<If>`, `<Else>`, `<Loop>`,
`<Break>`, `<Each>`, `<Let>`, `<Output>` and `<Return>` as structural syntax;
`<Elicit>`, `<File>`, `<Glob>`, `<Parse>` and `<SafeParse>` as core defaults;
`<Agent>`, `<Session>` and `<Prompt>` as registered agent components; and
`InstructionFiles`, `Discovery`, `UserCheckpoint`, `Planning` and
`Implementation` as the repository components beside this file.

## What this workflow is built on

What it needed was never one component. It was the retained-Workspace
implementation umbrella,
[#218](https://github.com/taras/executable.md/issues/218), whose dependency
order this workflow consumes in the same sequence — and the tables below record
what each of those issues delivered rather than what it owes.

**1. Retention and one filesystem vertical slice.**

| Capability | Issue | Status |
| --- | --- | --- |
| open and look up one WorkflowRun database; append and replay the filtered journal | #291 | shipped |
| commit a Workspace mutation, its logical root, and the journal result atomically | #365 | shipped |
| foreground `xmd workflow start` / `resume` with an implicit Workspace and declarative `<File>` effects | #366 | shipped |
| read-only `status`, `list` and `history` over immutable lifecycle snapshots | #367 slice 1, delivered by #460 | shipped |
| single-executor ownership, atomic begin/settle, cancellation, deletion, all owned by the executor lock | #367 slice 2, delivered by #466 | shipped |
| durable suspension, and releasing the executor lock back | #367 slice 3, delivered by #475 | shipped |
| versioned history checkpoints, compatible forks, `history --forkable`, forkability reasons, lineage, changed-definition replay admission and retained Workspace-root copying | #368, delivered by #498 | shipped |

`xmd workflow start` is what makes this document a workflow rather than a script,
and it exists: `xmd workflow start [--id] [--props-*] <definition>` creates the
run from committed Git bytes, gives it one implicit retained root Workspace,
binds `<File>` effects to that Workspace's transactions, denies services, streams
the document's output in the foreground, reports run identity and status on
standard error, and returns when the execution completes, fails, or is
interrupted. `xmd workflow resume <run-id>` selects only by run ID and reuses the
retained definition and props — a document path locates a definition and never
selects a previous run — replaying completed work and continuing the partial
remainder. Both are Deno-entrypoint and compiled-binary capabilities; the Node
and Bun entrypoints parse the grammar and refuse.

The command supplies the checkout, and a root reaches its stages by declaring
them. A workflow run still searches no repository directories at all; instead
`start.md` closes itself over a **component bundle** in its own frontmatter, and
`xmd workflow start` and `xmd workflow resume` resolve exactly those five names
from the blobs the pinned definition commit holds (#493, shipped, delivering
#301's component-bundle slice).

Identity is what the bundle buys. Each declared name normalizes to a canonical
repository-relative path and the blob's own object ID, and those entries join
workflow-definition identity and retained-history admission — so changing what a
stage says makes a different definition, and a resume or a replay reconstructs
the component from its retained source rather than from a mutable checkout. A
same-named file beside the definition answers nothing, an undeclared name
resolves to nothing at all, and ordinary `xmd run` resolution is unchanged.

The composition itself is what #301 built and this document writes: the
authored loop that runs discovery, planning, authorization, evaluation, Git, the
pull request, its evidence reads, review, deferred issues and acceptance as one
workflow run. #300 built the explicit host scheduling of its ordinary resume
beside it. Watchers and unattended continuation are excluded from both: a
continuation is asked for, by a person or by a trusted host, and both reach the
same executor.

**2. Repository and deterministic Git composition.**

| Capability | Issue | Status |
| --- | --- | --- |
| `<Repository>`, self-closing `<Worktree>`, and the lexical `<Dir>` boundary that consumes a bound checkout path | #293 | shipped — registered by the workflow host |
| `<Git.Switch>`, `<Git.Add>`, staged-only `<Git.Commit>` | #294 | shipped |
| shared Git-host effect reconciliation | #297 | shipped — one request-only surface, with `<Git.Push>` and `<PullRequest>` over it; `<Issue>` has its own `IssueApi` boundary |
| explicit `<Git.Push>` | delivered by #495 | shipped — registered by the workflow host |
| `<PullRequest>` over an explicitly pushed head | #295, delivered by #500 and #504 | shipped — registered by the workflow host |
| provenance-linked deferred `<Issue>`, in an `<IssueTracker>` | #296, delivered by #516 | shipped — registered by the workflow host; `IssueApi`, not a Git effect |
| ambient host authentication for private Git and supported forge effects | #532 | shipped — live host input, never a document prop or retained value |

**Authentication is the host's, acquired live** (#532, shipped). A run's
retained state says which repository an effect belongs to; it must not say who
this run is, because identity is a property of the machine the run is standing
on and a run resumed a week later elsewhere authenticates as whoever is there
then. HTTP Git asks the invoking user's ordinary credential-helper chain about
the exact locator. SSH uses the selected ambient agent and the invoking user's
known-host policy, where an unknown host is a refusal. GitHub API calls read
`GH_TOKEN`, then `GITHUB_TOKEN`, then `gh auth token --hostname github.com`.

A session is opened for one provider invocation and disposed with it. There is
no credential prop, no workflow secret schema, and nothing copied: a credential
is not an argument, a URL, a configuration file, the ambient environment, a
context, Workspace material, a retained value, a journal field, rendered output,
or a diagnostic cause. Replay acquires nothing at all — a completed effect
restores its retained result without reaching authentication — and an
interrupted one reacquires current host authentication and reconciles through
its provider contract. Agents receive neither credentials nor direct network
authority; this is a boundary the host holds, and no document can widen it.

Names are stable component identity, not magic configuration lookup: a
Repository's locator and base are ordinary root props or expressions. The first
local provider is expected to use native Git, because it gives the most faithful
checkout, worktree, and object-cache behavior; a browser provider may implement
the same contract differently, and may emulate named worktrees as separate
retained checkouts, without changing what a document writes (#293, #410). Initial
checkout speed is provider-owned acceleration — a host-local mirror or object
cache may change how fast a clone is, never what the run records or how it
replays.

`<Git.Commit>` is a Workspace-local durable effect and joins #365's transaction
boundary. What it journals is reconciliation evidence — repository and worktree
identity, branch, commit SHA, parent SHAs, tree SHA, staged paths, message
evidence — not raw Git object contents. Replaying a completed commit creates no
second commit; resuming after uncertain completion reconciles against retained
Workspace Git state, accepts a matching commit, treats missing retained state as
corruption, and fails on incompatible state without an implicit reset, rebase, or
merge.

`<Git.Push>` stays separate from both `<Git.Commit>` and `<PullRequest>` because
a remote ref cannot join the local transaction. It is an external effect that
observes remote state and adopts, performs, or fails — never force-pushes, never
resolves divergence implicitly, and never changes upstream tracking. It takes no
props and produces no result: the remote is the Repository's own `origin`, the
branch is the one the selected checkout is on, and the commit is the one that
branch points at, so there is nothing left to name. `<PullRequest>` depends on
that explicit pushed head rather than performing a hidden push — it requires
this run's own matching successful Push evidence for the exact Repository, head
branch, destination ref and commit, before a creation and before an update
alike.

**3. Agent authority and constrained execution.**

| Capability | Issue | Status |
| --- | --- | --- |
| provider-correct filesystem containment | #227 | open — `API.Files`, the host provider and the run's transaction-bound provider are built; the host validate-then-use race is what remains |
| the workflow Agent ceiling: no checkout, no materialization, no cwd, no registered directory, no `additionalDirectories`, no MCP server, no native tool | #302, delivered by #549 | shipped — with a retained session the run comes back to |
| the authored bounded observation loop, and `<Evaluate source>` | #302 and #369, delivered by #550 | shipped — declared to the execution by the workflow host |
| generated Workspace mutation admission, by effect class and authored form | #369, delivered by #572 | shipped — paired `<File>`, lexical `<Dir>` |
| generated single-file deletion | delivered by #574 | shipped — core's self-closing `<File.Delete>`, under the `write` class |
| engine-owned authored-form dispatch on the invocation it issued | #569 | shipped |
| transactional Worker Shell | #363 | **excluded from this delivery** — containment and transaction POCs are complete and it stays #363's; no stage here writes it, and nothing here waits on it |

The ceiling is the host's, not the document's, which is why no `<Sandbox>`
appears anywhere in this workflow. An implementor that cannot write returns XMD
instead, and the evaluator that admits it is built. It parses
the complete fragment and walks all of it before the first effect, resolves an
allowlist to pinned component identities the trusted host supplies, and refuses
everything outside that set — eval and exec blocks, expression props,
interpolation that reads a binding, a result binding, an unadmitted component,
and a malformed or out-of-ceiling request — naming the construct class and never
echoing the source. Only then does it expand what it admitted. Resolution
consults neither `componentDirs`, nor a registration, nor the workflow component
bundle, so a same-named file beside the checkout answers nothing. The allowlist
is authority, not prompting guidance: generated source cannot grant itself push,
pull-request, or secret access by naming a component. One durable event records
the decision before the first admitted observation, the admitted source and
normalized policy are retained in it, and a continuation is held to the exact
ceilings it was admitted under — so replay expands the same fragment without
asking the Agent again.

What that evaluator admits is decided by **class and authored form**. The
standard Deno workflow profile installs a read table — core's self-closing
`<File>` read — and a write table of exactly, in retained order: core's paired
`<File>` write, this package's lexical `<Dir>`, and core's self-closing
`<File.Delete>`. A document selects a class with `allow`, which chooses from
what the host already installed and can add nothing to it; omitting `allow`
means read-only. `<Fetch>` joins the read table only when a trusted host
captured a non-empty exact request ceiling, and an ordinary attachment supplies
none.

Preflight decides on the admitted name, the pinned definition **and the authored
form**, and canonical engine dispatch reports that form from the invocation it
issued (#569) — so contextual `Component.hasContent()` middleware cannot choose
read versus write for `<File>` or `<Dir>`, and a same-named repository component
or middleware answer supplies no admitted identity. File read, File write, Dir
and File.Delete each keep their own exact form contract.

What stays outside the class is every effect that reaches past the Workspace:
generated local Git, Git-host, issue, process, execution, credential and
external-write effects are not admitted, and a fragment naming one refuses
whole. This workflow performs those itself, as authored effects after
`<Evaluate>`.

**4. Compose and certify.**

| Capability | Issue | Status |
| --- | --- | --- |
| namespaced document props | #305 | shipped |
| synchronize this living target with settled contracts | #292 | this change |
| prove the shipped planning-document logic | #290 | implemented on PR #181; closes with its merge |
| a root's declared component bundle, resolved from its pinned commit | #301 slice, delivered by #493 | shipped |
| compose the supervised workflow — the authored loop from discovery to acceptance under one run | #301 | implemented on PR #181; closes with its merge |
| schedule the ordinary resume explicitly, as a trusted host | #300 | shipped — the host decides *when*, and nothing else |
| continue a run unattended — watchers, delivery-to-resume wiring, arbitration, a second executor | — | excluded; no issue owns one, and nothing here waits on one |
| omit an expression prop that evaluates to `undefined`, before validation and before the durable JSON boundary | delivered by #537 and #541 | shipped |
| typed durable answer delivery to a suspended run | #300 | shipped — delivery is non-executing, and a trusted host may schedule the ordinary resume explicitly; no watcher, no delivery-to-resume wiring, no second executor |
| default-on secret rejection before journal persistence | #199, delivered by #573 and #575 | shipped |
| certify interruption, replay, authority, reconciliation, and cross-runtime behavior | #299 | PASS at head `e85479c33ce4c91d821e0eaf195150db374ae4a6` over base `6717e867c9467114e6b060620d5b18c87beb2c48`; closed |

`<Discovery>`, `<Planning>`, `<Implementation>`, and `<UserCheckpoint>` are
authored Markdown components, not runtime primitives. `<UserCheckpoint>` combines
an agent prompt, conditional control flow, and `<Elicit>` to determine whether a
material choice requires the user and to obtain the user's answer when it does.
`<Planning>`, `<Implementation>` and `<UserCheckpoint>` declare `returns`: each
renders nothing, requires `as`, and binds a validated JSON value, because a
caller gates on a decision rather than on prose it would have to interpret.
`<Discovery>` is the text component of the four — it declares no `returns`, so
its `<Output>` region is its return value and `as` binds that rendered text,
which is all a prompt downstream needs.

Two authoring features sit deliberately outside this path.
[#412](https://github.com/taras/executable.md/issues/412) document targets and
[#416](https://github.com/taras/executable.md/issues/416) `<Call>` are useful, and
nothing here requires them; pulling either in is a separate decision.

No primitive this workflow writes is missing. The manual exercise that used to
replace one with a user-run step is history: every name resolves, and the run
performs the whole composition itself.

## What this workflow does not claim

These are exclusions, not roadmap promises. Nothing here waits on them, and no
stage degrades because one is absent.

| Nonclaim | Why it is one |
| --- | --- |
| transactional Worker Shell | #363's, and outside this delivery |
| portable adapter-level absence of every native tool | this host asks an adapter for none and refuses every request that arrives anyway; the portable proof is #496's, non-blocking |
| human actor attestation | nothing here identifies *who* answered a checkpoint beyond the answer this run retained |
| a remote-host selector | where a run executes is the caller's, and no document element chooses a host |
| configured watchers and unattended iteration | a continuation is asked for; #300 built only the decision of *when* an ordinary resume runs |
| speculative lab or play surfaces | this workflow ships one composition, and nothing here is a sandbox for another |

## What this workflow delivers

The supervised composition, the retained Workspace and its Repository and
Worktree checkouts, the generated observations and mutation, the local Git and
Git-host effects, the pull-request evidence reads, the deferred issues, the
retained Agent sessions, the durable checkpoints and the explicit scheduling of
their ordinary resume are all built in the revision containing this document.
PR #181 delivers them; #299 certified them from outside the process that runs
them, on the Deno source entrypoint and the compiled binary alike, at head
`e85479c33ce4c91d821e0eaf195150db374ae4a6` over base
`6717e867c9467114e6b060620d5b18c87beb2c48`. #290, #300 and #301 are implemented
on that pull request and close with its merge; #292 is the synchronization this
document is part of. #227, #327, #363 and #496 stay independent and
non-blocking.
