# Executable Markdown Agents

## Authority and startup

Before proposing or implementing changes:

1. Read the repository `AGENTS.md`.

That file is authoritative for agent roles, product decisions, planning and
review protocol, code rules, verification, writing, and pull requests. The
Effection v4 contract is inlined below, so no second startup document is
required. This file adds project-specific Claude Code behavior and does not
override the repository contract.

Claude Opus is the Implementor agent in this repository. It implements an
approved task and surfaces unresolved product decisions instead of deciding
them silently. Existing tests remain meaningful evidence and are changed only
when the approved task requires a behavior change.

## Working behavior

- Investigate the repository and relevant primary documentation before acting.
- Keep progress updates concise and lead final responses with the outcome.
- Use parallel tool calls for independent discovery or verification.
- Use exact paths, arguments, and observed values; do not invent placeholders.
- Make in-scope local changes directly and verify them proportionally to risk.
- Use subagents only for substantial work that is genuinely independent and
  parallelizable.
- Continue through long tasks and context compaction while preserving the
  current objective and verification state.
- State uncertainty when evidence or an appropriate tool is unavailable.

## Repository-specific safeguards

- The local repository contract wins when any imported guidance conflicts with
  `AGENTS.md`.
- Do not weaken tests, bypass required verification, or relax the one-PR-at-a-
  time process to make a task appear complete.
- Do not grant broad permissions merely to avoid prompts. Destructive commands,
  forceful Git operations, and shared external writes require explicit
  approval.
- Keep machine-specific settings in `.claude/settings.local.json` and scratch
  state in `.claude/local/` or an operating-system temporary directory. Do not
  create root-level `progress.txt` or `tests.json` files.
- Review future updates to this file as a contract diff. Preserve these local
  rulings when adapting upstream guidance.

## Inlined Effection v4 contract

This section is the Effection v4 `AGENTS.md` contract linked by the repository
`AGENTS.md`, inlined so the repository startup path needs only that local file.
When a rule here differs from the repository `AGENTS.md`, follow the local
repository rule. When an API is uncertain, inspect the repository source and
the public Effection API reference at https://frontside.com/effection/api/.

### Operations and scopes

- Do not invent APIs or infer Effection behavior from another ecosystem.
- Operations are lazy recipes and run only when interpreted with `yield*`,
  `run()`, `Scope.run()`, or `spawn()`.
- Promises are eager. Do not use `await` inside a generator; adapt an existing
  promise with `yield* until(promise)`.
- Work belongs to scopes. Scope exit halts its tasks, resources, streams, and
  subscriptions. References do not extend their lifetime.
- Values may escape a scope, but ongoing effects and context mutations must
  remain scope-bound.
- Prefer `main()` for whole programs and `yield* exit(status, message?)` for
  orderly termination. Do not call `process.exit()` or `Deno.exit()` directly.
- Do not use `createScope()` for ordinary application code. Reserve it for
  host integration and observe `destroy()` to complete teardown.
- Use `yield* useScope()` only when a callback must capture and re-enter the
  current scope.

### Concurrency and context

- `spawn(operation)` returns an operation; yielding it starts a task. A spawned
  task must not outlive its parent scope.
- `task.halt()` returns a future and must be observed. Consuming a task halted
  before completion fails with `Error("halted")`.
- `race()` accepts operations, returns the first result, and halts losers.
- `all()` runs operations concurrently in input order and halts remaining work
  on error. Use `allSettled()` when every result is required.
- Treat Effection context as scope-local. Use only `createContext`, `get`,
  `expect`, `set`, `delete`, and `with` through `yield*`; never use it as global
  mutable state.

### Interoperation and cleanup

- `call()` invokes a value-, promise-, or operation-returning function but does
  not create a scope boundary. Use `scoped()` when boundary semantics matter.
- `lift(fn)` defers calling `fn` until its operation is interpreted.
- Use `action()` for callback APIs when cleanup can be supplied.
- Use `until(promise)` for an already-created promise. It does not make that
  promise cancellable; use `useAbortSignal()` with a cancellable leaf API when
  needed.
- `resource()` performs setup before `provide()` and cleans up on return, error,
  and halt. Synchronous cleanup belongs in `finally`; asynchronous cleanup
  belongs in `ensure()`, not a `finally` that yields.
- `ensure(fn)` registers synchronous or operation-valued cleanup on the current
  scope. Register cleanup after any child work it depends on, because scope
  destructors run in reverse registration order.
- `useAbortSignal()` is an interop escape hatch for leaf APIs. Prefer rewriting
  nested asynchronous code in Effection instead of threading abort signals
  through it.

### Streams and messaging

- Adapt async iterators with `subscribe()` or async iterables with `stream()`;
  never use `for await` inside a generator.
- Consume streams with `each()`, calling `yield* each.next()` exactly once at
  the end of every iteration, including iterations that continue.
- Use `Channel` for in-operation messaging and observe `send()` and `close()`.
  Sends without subscribers are dropped.
- Use `Signal` only for synchronous callbacks into a stream; an unsubscribed
  signal send is a no-op.
- Use `Queue` for buffered, single-consumer values and consume with
  `yield* queue.next()`.

### Effection code style

- Use generator functions and `yield*` for operations; do not use promises or
  `async`/`await` in Effection control flow.
- Always brace `if` statements.
- Do not include agent marketing text or agent co-author trailers in commits,
  pull requests, issues, or comments.

## Upstream attribution

This file adapts compatible behavioral guidance from the MIT-licensed
`claude-opus-5` configuration in
`TechNomadCode/AI-Product-Development-Toolkit` at commit
`ed41972dff92cdbc94a60b2464531669900e602f`.

MIT License

Copyright (c) 2025 Tech Nomad

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
