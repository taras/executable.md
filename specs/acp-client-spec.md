# Executable.md ACP Client

The `Agent` Api, the `<Agent>` / `<Session>` / `<Prompt>` vocabulary, prompt
journaling and replay, the provider-factory seam, and the shared `Config`
timeout are implemented in `@executablemd/core`. A provider is supplied through
the `rootProvider` factory seam described below.

## The Agent Api

`Agent` is an Effection Api (`@executablemd/core`) for stateful coding-agent
sessions, distinct from the stateless Sample Api. It has exactly four
operations:

```ts
interface AgentApi {
  agent(name?: string): Operation<Agent>;
  session(name?: string): Operation<Session>;
  prompt(content: string, options?: PromptOptions): Operation<Stream<AgentPromptEvent, string>>;
  requestPermission(request: PermissionRequest): Operation<PermissionOutcome>;
}
```

- `Agent` is a resolvable agent name (a string). `Session` is
  `{ sessionKey; cwd; agentSessionId? }`. `PromptOptions` is
  `{ agent?; session?: string | Session; timeout? }`.
- `AgentPromptEvent` is `started` → zero or more `text_delta` → one `terminal`
  (`{ status: "completed" | "failed" | "cancelled"; stopReason?; error? }`).
- **Base behavior:** with no provider installed, `agent()`, `session()`, and
  `prompt()` report a missing provider; `prompt()` reports it **coldly** — the
  returned stream is handed back without starting a turn, and the failure
  surfaces only when it is subscribed. `requestPermission` has a working base
  that **denies**: it selects `reject_once`, then `reject_always`, and otherwise
  returns `{ outcome: "cancelled" }`.

### The provider-factory seam

A provider is a factory that installs `Agent` middleware for its scope:

```ts
type AgentProviderFactory = (options: AgentProviderOptions) => Operation<void>;
interface AgentProviderOptions { defaultAgent: string; permissionMode: PermissionMode; }
```

`installAgentVocabulary({ rootProvider: { factory, options } })` owns the root
provider's lifetime as part of each `DocumentExecution`: the factory runs inside
a scoped provider lifetime, the document renders through it, and the completion
resolves **only after the provider's finalizers have run**. Rendered output
closes independently of teardown. A provider-teardown failure folds into the
completion: an otherwise-successful run becomes an `Err`, and when the document
or its prompts already failed the teardown error joins them in an
`AggregateError` (primary errors first). Every finalizer runs even if one
throws.

## Components

`installAgentVocabulary()` teaches the expansion loop three words through the
core `expandInvocation` hook. Each supports the engine-wide `as` capture and
takes string/boolean **literals** only (expression props are rejected).

- **`<Agent name>`** resolves an agent and, for its body, pins it onto nested
  prompts. Self-closing validates only (no output).
- **`<Session name>`** resolves a session and pins it onto nested prompts.
  Self-closing validates only.
- **`<Prompt>`** sends one prompt and renders the reply.
  - Content is the rendered children; a self-closing `<Prompt prompt="…">` uses
    the `prompt` prop. Non-empty children always win over the prop.
  - `agent`, `session`, and `timeout` props override the enclosing scope for
    that prompt; `timeout` accepts a duration string.
  - `as="name"` captures the reply into the eval environment instead of
    emitting it.
  - `throwOnError` aborts the document on failure; without it, a failed prompt
    renders its partial text, the document continues, and the failure is
    aggregated into the execution completion as an `AggregateError` of
    `AgentPromptError`s ("N agent prompt(s) failed"), ordered by execution
    sequence.

## Journaling and replay

Each prompt is one durable operation (`agent_prompt`). The record carries the
prompt's identity and input, the agent and session identity, terminal status,
stop reason, text (including partial text on failure), and any structured
failure. A `sequence` records execution order explicitly, and per-location
ordinals keep durable identities stable across `<Each>` loops.

On a **full replay** (the journal already holds the root `Close`), completed
records are restored from the journal without contacting any provider —
producing identical output and identical aggregated failures. A prompt failure
that was thrown through `throwOnError` is marked `raised`; a partial replay
re-throws it, while a full replay omits it from aggregate restoration because it
was already handled where it occurred.

## Config

`Config` (`@executablemd/runtime`, re-exported from `@executablemd/core`) is the
shared execution config. It supplies the contextual `timeout` in milliseconds
(default 120 000). Override it for a scope with
`yield* Config.around({ timeout: () => 30_000 }, { at: "min" })`. The validated
`yield* timeout` operation returns a positive, finite number of milliseconds and
throws on any other value (zero, negative, NaN, Infinity, or a non-number).
