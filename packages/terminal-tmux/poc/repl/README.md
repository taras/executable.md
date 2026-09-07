# Black-box terminal REPL POC (issue #774)

A finite, disposable proof — not the production REPL, and not part of any package
export. It answers one question:

> Can generic terminal-state convergence make black-box tmux input delivery
> reliable enough while provider session files supply authoritative acceptance and
> completion?

Nothing here is exported from `@executablemd/terminal-tmux`. It is reached only by
the deterministic evidence in `packages/terminal-tmux/tests/repl-poc.test.ts` and,
under explicit authorization, by the live supervisor here. It adds no Workflow
capability, no journal record, no replay rule, and no workflow syntax.

## The pieces

- `state.ts`, `actions.ts` — one Flux-style immutable state and its closed action
  vocabulary. Actions are the only way state changes; the reducer is the only place
  a transition is written.
- `store.ts` — a sequence-numbered, staged-write action log. Restart replays it and
  refuses a gap, a duplicate or a malformed record.
- `observer.ts` with `claude-observer.ts` and `codex-observer.ts` — a strict,
  read-only provider session-file boundary. It matches only the exact native
  identity, advances the cursor only past a complete record, and refuses on
  ambiguity, truncation, rotation, identity mismatch or an unsupported shape. It
  never writes to a provider file.
- `convergence.ts` — the generic terminal-convergence algorithm. No prompt or
  screen-text parsing: two structurally equal snapshots across an acknowledged
  barrier, no intervening event, and no open provider turn.
- `delivery.ts` — literal delivery through a private `0600` file and a uniquely
  named tmux buffer, with a separate submit key. Message bytes never enter a shell
  or a tmux argument vector.
- `controller.ts` — the message lifecycle: converge, record intent durably, paste
  under a final guard, then confirm acceptance from the provider file. An unproved
  outcome becomes uncertain and is never pasted again.
- `report.ts` with `report.schema.json` — the `terminal-repl-poc-report.v1`
  artifact and its validator. It carries hashes, counters, versions, turn budgets,
  the RP matrix and restart/cleanup evidence, and no conversation content.
- `live-supervisor.ts`, `live-worker.ts`, `TerminalReplClaude.md`,
  `TerminalReplCodex.md`, `ClaudeBlackBoxRepl.test.md`, `CodexBlackBoxRepl.test.md` — the gated live
  journey. It refuses before starting any agent or opening any transcript unless
  both of its exact gates are supplied.

## The deterministic matrix

`packages/terminal-tmux/tests/repl-poc.test.ts` freezes RP1–RP18 and runs them
against fake panes and synthetic append-only session files. The fake pane exposes
hidden busy and manual ground truth only to the assertions, never to the
algorithm, so a paste admitted while the pane was busy or a person was typing is
caught. Run it with:

```sh
deno task test packages/terminal-tmux/tests/repl-poc.test.ts
```

## The live journey

The live journey never runs in ordinary CI and spends real model turns. It is gated
twice over per provider, and previous authorization does not count:

```sh
XMD_TERMINAL_REPL_CLAUDE_PROOF=1 XMD_TERMINAL_REPL_CLAUDE_MODEL_TURNS_AUTHORIZED=1 \
  deno task xmd test packages/terminal-tmux/poc/repl/ClaudeBlackBoxRepl.test.md --raw

XMD_TERMINAL_REPL_CODEX_PROOF=1 XMD_TERMINAL_REPL_CODEX_MODEL_TURNS_AUTHORIZED=2 \
  deno task xmd test packages/terminal-tmux/poc/repl/CodexBlackBoxRepl.test.md --raw
```

Without both exact values the supervisor prints a `NOT_AUTHORIZED` report and starts
nothing. Each provider has its own single-pane grid document, so authorizing one
provider can never launch the other. The live journey body in `live-worker.ts` is
unexercised until an authorized run, which is the only context allowed to spend the
turns it needs.
