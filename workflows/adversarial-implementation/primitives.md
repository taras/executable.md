# Primitive Inventory

## XMD execution foundation

XMD already supplies component expansion, root document props, prompt capture,
agent selection, named sessions, collection iteration, scoped permission
policies, and scope-owned process and agent teardown. Its durable execution
layer also assigns deterministic execution identities, journals effects, and
observes completion, failure, or cancellation. Replay restores a recorded
outcome without re-executing it, and a run that failed is still a complete
record: replaying it restores the output and the failure alike. Replay
determinism means the journal does not lose the execution chain — replaying
arrives at the same state, where execution can resume.

Those capabilities remain internal execution machinery. The low-level journal
is not the user-facing artifact ledger of an implementation workflow.

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
created inside the run it describes, provided contextually, and torn down with
it. There is no module-scoped registry for this workflow to reach.

## How an error is decided

Every region of every document carries an error mode, set by the lexical
structure and read where an error is raised:

| Mode | An undecided error… | Installed by |
| --- | --- | --- |
| `print` | is printed into the document; the run continues | the root; `<PrintErrors>` |
| `output` | fails the run; the region keeps what it already rendered | every `<Output>` region |
| `throw` | fails the run, and no printing boundary replaces it | documentation; value roots |

A component body is split by its `<Output>` boundary: the region inside runs
under `output`, everything outside is documentation and runs under `throw`.
Every stage in this workflow puts its prompts, parsing, and control flow outside
`<Output>`, so a stage returns a complete validated result or it fails — it
never returns a half-record. `<Retry>` and `<Result as>` would let a document
handle a failure instead of ending on it; both are defined and unbuilt.

## What the workflow already writes

**Structural syntax** is the language's own. A registration cannot claim one of
these names and a repository file never stands in for it:

1. `<If>` with an optional nested `<Else>`, and `<Loop>` with `<Break>`, provide
   visible bounded control flow. `<Loop>` requires `max`, opens no binding
   scope, and completes normally when it reaches that bound.
2. `<Answers>` and `<Answer>` supply elicitation responses from the document.
   `<Answers>` installs a provider around its body and answers from its
   matchers; it reads them as elements before they expand, which is why a
   registered component could not implement it.
3. `<Return>` selects a value component's return value.
4. `<Content>`, `<Output>`, `<Capture>`, `<Each>`, and `<PrintErrors>` complete
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
   and renders nothing at all — no output, no path, no write handle. Everything
   it touches stays inside `Env.cwd`, checked lexically before any filesystem
   call and again against resolved symlinks immediately before the write. That
   is traversal confinement, not a security sandbox: containment that does not
   depend on observed filesystem state is [issue
   #227](https://github.com/taras/executable.md/issues/227).
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
   provider, and changing the provider changes no Markdown. Only the validated
   answer is journaled, keyed by a fingerprint of the compiled schema and the
   rendered message, so a resumed run restores it rather than asking twice and
   refuses an answer recorded against a different question.
9. `<TempDir>` establishes a fresh contextual working directory for its content
   and removes it when the content finishes, fails, or is cancelled.

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
    failure.

**One asymmetry to know.** An expression prop reads a **bare** binding, while
text and content interpolation read the **namespace**: `agent={planner}` and
`{props.instructions}` are both correct today, and `agent={props.planner}` fails
with `props is not defined`. Removing that split is [issue
#305](https://github.com/taras/executable.md/issues/305), which will let
expression props read `props.name` and migrate these documents.

The document-level logic in `InstructionFiles`, `Discovery`, `Planning`, and
`UserCheckpoint` therefore uses shipped syntax throughout. `Implementation` does
not: its loop body invokes `<Commit>`, `<PullRequest>`, and `<Issue>`, which
resolve to nothing, so that stage cannot expand.

## What the workflow still needs

`<Workflow>` organizes existing XMD behavior into an authored process. It
correlates captures and deterministic effects, presents durable replay as one
run reaching the state a later stage resumes from, and derives the run outcome
from XMD's execution result. None of it exists yet ([issue
#289](https://github.com/taras/executable.md/issues/289)).

The component adds the product behavior that XMD does not supply:

- create or resolve a stable run identity without exposing a `runId` prop;
- resolve `base` once to a pinned source revision;
- install run identity and pinned source revision through a contextual Run API;
- restore a stage's declared inputs by stable component and loop-iteration
  identity;
- record artifact versions, environmental effects, and stop reasons;
- reconcile external effects with the run identity; and
- persist the artifact ledger when `historyRef` selects a sidecar location
  (#291).

Descendants consume this context internally. Authors access the run identity
through the API only when workflow logic genuinely needs it. Every workflow has
an execution-local run manifest; `historyRef` makes that record durable outside
the executing process.

The remaining contracts are missing on the same terms:

1. `<Stage>` selects one stage, restores its declared inputs, publishes its
   outputs, and stops cleanly at the stage boundary
   ([#298](https://github.com/taras/executable.md/issues/298)). Cross-process
   continuation is its problem rather than `<Elicit>`'s: elicitation answers a
   question inside one run and does not resume a stopped one.
2. `<Sandbox>` enforces filesystem, environment, process, network, and durable
   effect capabilities as a boundary that can be relied on
   ([#302](https://github.com/taras/executable.md/issues/302)). `<File>` and
   `<Glob>` confine traversal today, but confinement that survives concurrent
   filesystem mutation is [issue
   #227](https://github.com/taras/executable.md/issues/227).
3. `<Worktree>` reconciles a workspace from the run's pinned source revision,
   sets `Env.cwd` while rendering its children, and cleans up safely
   ([#293](https://github.com/taras/executable.md/issues/293)). This workflow
   keeps discovery, implementor planning, implementation, and review in that
   same workspace. `Env.cwd` itself is implemented; what is missing is the
   workspace that establishes it and the retention rules that survive failure.
4. `<Commit>` validates exact changes and owns Git metadata writes
   ([#294](https://github.com/taras/executable.md/issues/294)).
5. `<PullRequest>` ([#295](https://github.com/taras/executable.md/issues/295))
   and `<Issue>` ([#296](https://github.com/taras/executable.md/issues/296))
   reconcile durable GitHub effects idempotently, over the shared
   reconciliation described by
   [#297](https://github.com/taras/executable.md/issues/297).
6. Replay across replaced ephemeral environments, so a recorded effect is never
   restored under a directory the current run did not create ([issue
   #218](https://github.com/taras/executable.md/issues/218)).
7. Default-on rejection of secrets before a journal event or a sidecar Git
   object becomes durable ([issue
   #199](https://github.com/taras/executable.md/issues/199)). The pre-persistence
   guard and the offline scanner are built; the execution policy, its default-on
   wiring, and the CLI opt-out and warning are not.

`<Discovery>`, `<Planning>`, `<Implementation>`, and `<UserCheckpoint>` are
authored Markdown components, not runtime primitives. `<UserCheckpoint>`
combines an agent prompt, conditional control flow, and `<Elicit>` to determine
whether a material choice requires the user and to obtain the user's answer
when it does.

Where a primitive is still missing, the manual exercise replaces it with an
explicit user-run step and records the replacement as evidence for prioritizing
implementation.
