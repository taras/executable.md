# Primitive Inventory

## XMD execution foundation

XMD already supplies component expansion, root document inputs, prompt capture,
agent selection, named sessions, collection iteration, scoped permission
policies, and scope-owned process and agent teardown. Its durable execution
layer also assigns deterministic execution identities, journals effects,
replays recorded results, and observes completion, failure, or cancellation.

Those capabilities remain internal execution machinery. The low-level journal
is not the user-facing history of an implementation workflow.

## Workflow context

`<Workflow>` organizes existing XMD behavior into an authored process. It
correlates captures and deterministic effects, presents durable replay as
resumption of one internal run, and derives the run outcome from XMD's execution
result.

The component adds the product behavior that XMD does not yet supply:

- create or resolve a stable internal run identity without exposing a `runId`
  prop;
- resolve `base` once to a pinned source revision;
- install run identity and source revision through a contextual Run API;
- restore named stage inputs by stable component and loop-iteration identity;
- record immutable artifact versions, environmental effects, and stop reasons;
- reconcile external effects with the internal run identity; and
- persist the run record when `historyRef` selects a sidecar location.

Descendants consume this context internally. Authors access the run identity
through the API only when workflow logic genuinely needs it. Every workflow has
an execution-local run record; `historyRef` makes that record durable outside
the executing process.

## Additional workflow contracts

1. `<Stage>` selects one manual stage, restores its inputs, and publishes its
   outputs.
2. `<Sandbox>` enforces filesystem, environment, process, network, and durable
   effect capabilities.
3. `<Worktree>` reconciles a workspace from the source revision pinned by the
   run, supplies contextual working directory, sets `Env.cwd` while rendering
   its children, and cleans up safely. This workflow keeps discovery,
   implementor planning, implementation, and review in that same workspace.
4. `<Glob>` evaluates explicit include and exclude patterns relative to
   `Env.cwd` and binds a deduplicated, deterministically ordered list of
   normalized relative paths. Its typed list output is a concrete use case for
   structured component output.
5. A self-closing `<File>` reads and renders exact repository content relative
   to `Env.cwd`. The content-writing form is reserved for source changes,
   explicit exports, and external tools that require a path. Generated
   handoffs, plans, reviews, and decisions remain captured values in run
   history. The `path` prop selects a persistence location; it is not an output
   value. Structured file handles remain part of the structured-output design.
6. `<Parse>` renders its children, decodes the result as JSON, validates it
   against captured draft-07 JSON Schema content, and binds the validated value
   through `as`. It fails on malformed or invalid content. `<SafeParse>`
   performs the same deterministic work but binds either
   `{ ok: true, value }` or `{ ok: false, input, errors }`; errors use the
   normalized validation issue shape already used by input validation. Both
   require `as`, emit no rendered content, compile the schema before expanding
   their children, and propagate child execution failures rather than treating
   them as parse failures.
7. Structured Markdown component output remains distinct from parsing content
   inside a document. The workflow does not assume a named schema registry or a
   `<Prompt schema>` prop. [Issue
   #176](https://github.com/taras/executable.md/issues/176) tracks the component
   output contract.
8. Agent role selection accepts a validated workflow input rather than
   requiring the `<Agent name>` prop to be a literal.
9. `<Elicit>` renders its children as the request message, accepts a response
    schema that defines the exact fields and options available to the user, and
    binds the validated response directly. The manual exercise obtains that
    response through an explicit user-run step; runtime input can provide it
    later. The primitive does not add protocol-defined actions, determine
    whether involvement is required, or make a decision. Cancelling execution
    remains a lifecycle event unless the document explicitly includes
    cancellation as a response option.
10. `<Loop>`, `<If>` with an optional nested `<Else>`, and `<Break>` provide
    visible bounded control flow.
    [Issue #78](https://github.com/taras/executable.md/issues/78) defines the
    structural `<If>/<Else>` contract.
11. `<Commit>` validates exact changes and owns Git metadata writes.
12. `<PullRequest>` and `<Issue>` reconcile durable GitHub effects
    idempotently.

`<Discovery>`, `<Planning>`, `<Implementation>`, and `<UserCheckpoint>` are
authored Markdown components, not runtime primitives. `<UserCheckpoint>`
combines an agent prompt, conditional control flow, and `<Elicit>` to determine
whether a material choice requires the user and to obtain the user's answer
when it does.

The manual exercise replaces a missing primitive with an explicit user-run
step. It records each replacement as evidence for prioritizing implementation.
