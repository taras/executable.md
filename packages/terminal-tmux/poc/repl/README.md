# Black-box terminal REPL POC (issue #774) — result: VIEW_ONLY

A finite, disposable proof — not the production REPL, and not part of any package
export. It asked one question:

> Can generic terminal-state convergence make black-box tmux input delivery
> reliable enough while provider session files supply authoritative acceptance and
> completion?

**The decision is VIEW_ONLY.** Passive session-file observation is sound, but
reliable message dispatch cannot be established over black-box tmux input and
stays ACP-owned. The reasoning and the exact race are in [`RESULT.md`](./RESULT.md).

Nothing here is exported from `@executablemd/terminal-tmux`. It is reached only by
the deterministic evidence in `packages/terminal-tmux/tests/repl-poc.test.ts`. It
adds no Workflow capability, no journal record, no replay rule, and no workflow
syntax, and it changes no production, architecture or specification file.

## What the evidence establishes

- `state.ts`, `actions.ts`, `store.ts` — a Flux-style immutable store with a
  closed action vocabulary and a sequence-numbered, staged-write log that replays
  on restart and refuses gaps, duplicates, malformed records and illegal
  transitions.
- `observer.ts` with `claude-observer.ts` and `codex-observer.ts` — a strict,
  read-only session-file observer. It locates by exact native identity and project
  from bounded header reads, advances the cursor only past a complete record,
  groups Claude output by its `requestId` turn, and refuses ambiguity, truncation,
  rotation, identity mismatch and unsupported shapes. It never writes a provider
  file. **This is the reusable outcome.**
- `convergence.ts` — the generic terminal-convergence algorithm. No screen-text
  parsing: two structurally equal pane samples across an acknowledged barrier,
  with the provider's open-turn, cursor, event count and physical size unchanged.
- `delivery.ts` — literal delivery through a private `0600` file and a uniquely
  named tmux buffer, prepared before the final sample, with a separate submit key.
- `controller.ts` — the message lifecycle: converge, prepare, final sample,
  durable `AttemptStarted`, one guarded paste, then acceptance from the provider
  file. Any unproved outcome becomes uncertain and is never retried.
- `report.ts` with `report.schema.json` — the `terminal-repl-poc-report.v1`
  artifact, its validator, and the overall aggregator whose `PASS` was reachable
  only with both live provider journeys.
- `live-worker.ts` — the terminal boundary kept as evidence: the pane probe over
  an injectable tmux command seam and a real control-mode activity source, with
  the single conditional guard the boundary would use.

## The live journey is closed out

The POC reached its decision without a live model turn, and the live-delivery
journey is permanently disabled. `live-supervisor.ts`'s `runLiveProof` launches no
coding agent and spends no turn under any environment; it returns the VIEW_ONLY
conclusion. The grid launch documents and the two live proof documents have been
removed.

## Running the evidence

```sh
deno task test packages/terminal-tmux/tests/repl-poc.test.ts
```

The deterministic suite freezes RP1–RP18 plus supporting boundary rows and passes
under Deno, Node and Bun. It records the VIEW_ONLY conclusion in a schema-valid
overall report.
