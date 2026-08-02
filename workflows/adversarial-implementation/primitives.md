# Primitive Inventory

## XMD execution foundation

XMD already supplies component expansion, root document props, prompt capture,
agent selection, named sessions, collection iteration, scoped permission
policies, and scope-owned process and agent teardown. Its durable execution
layer also assigns deterministic execution identities, journals effects,
replays recorded results, and observes completion, failure, or cancellation.

Those capabilities remain internal execution machinery. The low-level journal
is not the user-facing history of an implementation workflow.

## What the workflow already writes

Name resolution has tiers, and where a name sits decides whether this workflow
can rely on it and whether a repository file may replace it.

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
4. `<Content>`, `<Output>`, `<Capture>`, `<Each>`, and `<CollectFailures>`
   complete the set.

**Core defaults** ship in the compiled binary and every published package, with
no search path and no `--component-dir`. They are ordinary defaults rather than
reserved names, so a repository component may override each one:

5. `<Glob>` evaluates explicit include and exclude patterns relative to
   `Env.cwd`. It declares `returns`, so it renders nothing, must be invoked
   with `as`, and binds one `string[]`: relative paths, `/`-separated on every
   platform, deduplicated, and sorted lexically by code point. Directories and
   symbolic links are never results, which is what keeps a search inside
   `Env.cwd` without judging any destination. Finding nothing is an empty array
   rather than a failure.
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

**Registered agent components** are defaults on the same terms:

10. `<Agent name>` and `<Session name>` pin an agent and a session onto nested
    prompts; `<Prompt>` sends one prompt and renders the reply, with `agent`,
    `session`, and `timeout` overriding the enclosing scope and `throwOnError`
    aborting the document on failure. Their props take a literal or an
    expression that resolves to a string, so this workflow selects the planner
    and implementor from validated root props rather than literals. Each prompt
    is one durable operation whose record carries its identity, input, agent
    and session, terminal status, text, and structured failure.

The document-level logic in `InstructionFiles`, `Discovery`, `Planning`, and
`UserCheckpoint` therefore uses shipped syntax throughout.

## What the workflow still needs

`<Workflow>` organizes existing XMD behavior into an authored process. It
correlates captures and deterministic effects, presents durable replay as
resumption of one internal run, and derives the run outcome from XMD's execution
result. None of it exists yet.

The component adds the product behavior that XMD does not supply:

- create or resolve a stable internal run identity without exposing a `runId`
  prop;
- resolve `base` once to a pinned source revision;
- install run identity and source revision through a contextual Run API;
- restore named stage props by stable component and loop-iteration identity;
- record immutable artifact versions, environmental effects, and stop reasons;
- reconcile external effects with the internal run identity; and
- persist the run record when `historyRef` selects a sidecar location.

Descendants consume this context internally. Authors access the run identity
through the API only when workflow logic genuinely needs it. Every workflow has
an execution-local run record; `historyRef` makes that record durable outside
the executing process.

The remaining contracts are missing on the same terms:

1. `<Stage>` selects one manual stage, restores its props, publishes its
   outputs, and stops cleanly at the stage boundary. Cross-process continuation
   is its problem rather than `<Elicit>`'s: elicitation answers a question
   inside one run and does not resume a stopped one.
2. `<Sandbox>` enforces filesystem, environment, process, network, and durable
   effect capabilities as a boundary that can be relied on. `<File>` and
   `<Glob>` confine traversal today, but confinement that survives concurrent
   filesystem mutation is [issue
   #227](https://github.com/taras/executable.md/issues/227).
3. `<Worktree>` reconciles a workspace from the source revision pinned by the
   run, supplies contextual working directory, sets `Env.cwd` while rendering
   its children, and cleans up safely. This workflow keeps discovery,
   implementor planning, implementation, and review in that same workspace.
   `Env.cwd` itself is implemented; what is missing is the workspace that
   establishes it and the retention rules that survive failure.
4. `<Commit>` validates exact changes and owns Git metadata writes.
5. `<PullRequest>` and `<Issue>` reconcile durable GitHub effects
   idempotently.
6. Replay across replaced ephemeral environments, so a recorded effect is never
   restored under a directory the current run did not create ([issue
   #218](https://github.com/taras/executable.md/issues/218)).

`<Discovery>`, `<Planning>`, `<Implementation>`, and `<UserCheckpoint>` are
authored Markdown components, not runtime primitives. `<UserCheckpoint>`
combines an agent prompt, conditional control flow, and `<Elicit>` to determine
whether a material choice requires the user and to obtain the user's answer
when it does.

Where a primitive is still missing, the manual exercise replaces it with an
explicit user-run step and records the replacement as evidence for prioritizing
implementation.
