# @executablemd/test-agent

A deterministic ACP agent. In place of a real coding agent (Codex, Claude
Code), it answers prompts by advancing through a Markdown _behavior
document_, so agent integrations can be tested against scripted, repeatable
responses instead of a probabilistic model.

The worker speaks the [Agent Client Protocol](https://agentclientprotocol.com)
over stdio, so any ACP client can drive it. This walkthrough drives it with
the real ACPX CLI across two stateful prompt stages.

## The behavior document

`examples/review.md` is a two-stage scenario. Each `<WhenPrompt>` matches one
prompt; the Markdown after a match is the response for that turn. The first
stage captures `{?subject}` and `{?revision}`; the second reuses the captured
`subject`:

```md
<WhenPrompt
  as="review"
  template="Review {?subject} at revision {?revision}"
/>

The review of **{review.subject}** at `{review.revision}` passed.

<WhenPrompt template="Summarize {review.subject}" />

The review of **{review.subject}** passed.
```

## Run the walkthrough

The worker is controller-launched: a controller mints the scenario route, and
the worker connects back to it — the worker cannot run without the running
controller. Start the smallest such controller (`examples/acpx-walkthrough.ts`):

```
deno run --allow-all packages/test-agent/examples/acpx-walkthrough.ts
```

It stays running and prints the two commands to run, each launching the worker
from this checkout's CLI **source** — so nothing needs to be installed first.
In another terminal, run them in order. Copy the exact lines it prints; the
absolute `cli.ts` path and the `<route>` are filled in for you:

```
acpx --agent "deno run --allow-all '<abs>/packages/cli/src/cli.ts' test-agent --connect <route>" exec "Review packages/core at revision abc123"
acpx --agent "deno run --allow-all '<abs>/packages/cli/src/cli.ts' test-agent --connect <route>" exec "Summarize packages/core"
```

How the pieces fit together:

- **ACPX** owns `--agent` (the command it spawns as the agent) and the `exec`
  subcommand (send one prompt, print the response, exit).
- **`xmd test-agent`** owns `--connect` (the controller route it dials back to).
- The **running controller** above mints that route; the worker cannot start
  without it.

The first command prints:

```
The review of **packages/core** at `abc123` passed.
```

and the second prints:

```
The review of **packages/core** passed.
```

Each `exec` invocation is one-shot: ACPX opens a new temporary ACP session and
a fresh worker process for it, sends the prompt, prints the response, and exits.
ACPX does not call `session/load` or reuse any saved session state between the
two invocations. The `subject` capture survives from the first turn to the
second only because the controller journals each completed stage, and every new
worker rehydrates from that journal — not from in-process or ACPX session state.

### After `xmd` is released

Once a compiled `xmd` is on your `PATH`, the agent command shortens to the
released binary — everything else is identical:

```
acpx --agent "xmd test-agent --connect <route>" exec "Review packages/core at revision abc123"
acpx --agent "xmd test-agent --connect <route>" exec "Summarize packages/core"
```

## What this proves, and what it does not

Two separate `exec` invocations are two separate temporary sessions and worker
processes, so the walkthrough shows a fresh worker advancing the same behavior
document — carried entirely by the controller's journal, not by any ACPX
session state. It does **not** exercise ACP `session/load`: ACPX's `exec` never
loads a saved session. The `session/load` restart path — killing a worker
mid-scenario and rehydrating a replacement through `session/load` — is covered
automatically by `tests/worker-lifecycle.test.ts`; prefer that test for
regression coverage. This walkthrough is for seeing the worker run against a
real ACP client by hand.

`xmd test-agent` runs only as a controller-launched worker — it has no
standalone behavior-document mode.
