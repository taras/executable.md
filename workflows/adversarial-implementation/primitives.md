# Primitive Inventory

The current runtime already supplies:

- Agent selection and named sessions
- Prompt capture as text
- Scoped permission policies
- Execution journaling and replay
- Scope-owned process and agent teardown
- Root document inputs
- Collection iteration with `<Each>`

The workflow exposes these missing contracts:

1. `<Stage>` selects one manual stage, restores its inputs, and publishes its
   outputs.
2. `<RunHistory>` creates or resolves the stable run identity, resolves its
   `base` prop once to a source revision, installs both through the Run API, and
   automatically snapshots execution records and immutable versions of named
   captures. Resuming a stage restores captured values by stable component and
   loop-iteration identity. Descendants consume that context internally;
   authors access the identity only through the API when they genuinely need
   it.
3. `<Sandbox>` enforces filesystem, environment, process, network, and durable
   effect capabilities.
4. `<Worktree>` reconciles a workspace from the source revision pinned by the
   run, supplies contextual working directory, sets `Env.cwd` while rendering
   its children, and cleans up safely. This workflow keeps discovery,
   implementor planning, implementation, and review in that same workspace.
5. `<Glob>` evaluates explicit include and exclude patterns relative to
   `Env.cwd` and binds a deduplicated, deterministically ordered list of
   normalized relative paths. Its typed list output is a concrete use case for
   structured component output.
6. A self-closing `<File>` reads and renders exact repository content relative
   to `Env.cwd`. The content-writing form is reserved for source changes,
   explicit exports, and external tools that require a path. Generated
   handoffs, plans, reviews, and decisions remain captured values in run
   history. The `path` prop selects a persistence location; it is not an output
   value. Structured file handles remain part of the structured-output design.
7. `<Parse>` renders its children, decodes the result as JSON, validates it
   against captured draft-07 JSON Schema content, and binds the validated value
   through `as`. It fails on malformed or invalid content. `<SafeParse>`
   performs the same deterministic work but binds either
   `{ ok: true, value }` or `{ ok: false, input, errors }`; errors use the
   normalized validation issue shape already used by input validation. Both
   require `as`, emit no rendered content, compile the schema before expanding
   their children, and propagate child execution failures rather than treating
   them as parse failures.
8. Structured Markdown component output remains distinct from parsing content
   inside a document. The workflow does not assume a named schema registry or a
   `<Prompt schema>` prop. [Issue
   #176](https://github.com/taras/executable.md/issues/176) tracks the component
   output contract.
9. Agent role selection accepts a validated workflow input rather than
   requiring the `<Agent name>` prop to be a literal.
10. `<Elicit>` renders its children as the request message, accepts a response
    schema that defines the exact fields and options available to the user, and
    binds the validated response directly. The manual exercise obtains that
    response through an explicit user-run step; runtime input can provide it
    later. The primitive does not add protocol-defined actions, determine
    whether involvement is required, or make a decision. Cancelling execution
    remains a lifecycle event unless the document explicitly includes
    cancellation as a response option.
11. `<Loop>`, `<If>` with an optional nested `<Else>`, and `<Break>` provide
    visible bounded control flow.
    [Issue #78](https://github.com/taras/executable.md/issues/78) defines the
    structural `<If>/<Else>` contract.
12. `<Commit>` validates exact changes and owns Git metadata writes.
13. `<PullRequest>` and `<Issue>` reconcile durable GitHub effects
    idempotently.

`<UserGate>` is an authored Markdown component, not a runtime primitive. It
combines an agent prompt, conditional control flow, and `<Elicit>` to
determine whether a material choice requires the user and to obtain the user's
answer when it does.

The manual exercise replaces a missing primitive with an explicit user-run
step. It records each replacement as evidence for prioritizing implementation.
