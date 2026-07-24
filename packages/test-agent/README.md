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

The worker is controller-launched: a controller registers the scenario and
hands out an opaque route, and the worker connects back to it. Start the
smallest such controller (`examples/acpx-walkthrough.ts`):

```
deno run --allow-all packages/test-agent/examples/acpx-walkthrough.ts
```

It prints a route and the two commands to run. In another terminal, drive the
worker with ACPX, passing the worker command to `--agent`:

```
acpx --agent "xmd test-agent --connect <route>" exec "Review packages/core at revision abc123"
acpx --agent "xmd test-agent --connect <route>" exec "Summarize packages/core"
```

The first command prints:

```
The review of **packages/core** at `abc123` passed.
```

and the second — a fresh worker process that resumes the same session through
`session/load` — prints:

```
The review of **packages/core** passed.
```

The `subject` capture survives from the first turn to the second because the
controller journals each completed stage; every new worker rehydrates from
that journal rather than from in-process state.

Without a compiled `xmd` on your `PATH`, use the worker command directly:

```
acpx --agent "deno run --allow-all packages/cli/src/cli.ts test-agent --connect <route>" exec "Review packages/core at revision abc123"
```

## What this proves, and what it does not

Two separate ACPX invocations are two separate worker processes, so the
walkthrough shows a fresh worker resuming mid-scenario — the same restart and
`session/load` path that `tests/worker-lifecycle.test.ts` verifies
automatically, including killing the worker between stages. Prefer that test
for regression coverage; this walkthrough is for seeing the worker run against
a real ACP client by hand.

`xmd test-agent` runs only as a controller-launched worker — it has no
standalone behavior-document mode.
