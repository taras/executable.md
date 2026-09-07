# Black-box REPL messaging to a native Codex pane

`xmd run` can open a Codex coding agent in a terminal pane. This document asks the
one question the POC exists to answer for Codex: **can generic terminal-state
convergence deliver one literal REPL message into that pane, and can Codex's own
rollout file confirm the exact message was accepted and answered — without any
hook, plugin, or screen scraping?**

The journey launches the real grid, waits for the pane's terminal to converge on a
safe input point, pastes one uniquely-marked message as literal bytes, and then
reads Codex's own rollout file for the exact user event and its completion. The
terminal only ever authorizes the attempt; acceptance is the provider file's word.

## What this costs, and what it touches

At most two Codex model turns against the operator's own credentials: one if the
thread is already resumable, otherwise one materialization turn and one marker
turn. It runs under a private `HOME` and `TMPDIR`, so `.xmd`, `.acpx`, the
adapters, the launch journal, the tmux server and the POC store are isolated.
`CODEX_HOME` is left as the operator has it so Codex stays authenticated; nothing
beneath it is swept. The conversation this run creates is removed afterward through
Codex's own `delete`.

It is gated twice over. Without `XMD_TERMINAL_REPL_CODEX_PROOF=1` and
`XMD_TERMINAL_REPL_CODEX_MODEL_TURNS_AUTHORIZED=2`, the supervisor refuses before
any agent starts and before any transcript is opened, printing a `NOT_AUTHORIZED`
report that spent nothing. That is the branch that runs on an ordinary machine and
in CI.

Run it, once authorized, with:

```sh
XMD_TERMINAL_REPL_CODEX_PROOF=1 XMD_TERMINAL_REPL_CODEX_MODEL_TURNS_AUTHORIZED=2 \
  deno task xmd test packages/terminal-tmux/poc/repl/CodexBlackBoxRepl.test.md --raw
```

## What a verdict may say

The report carries versions, hashes, counters, turn budgets and cleanup outcomes,
and no conversation: no transcript, no reply, no path, no argv, no environment, no
tmux identifier, and no raw native identity.

<Let as="reportSchema" select="code[lang=json]">

```json
{
  "type": "object",
  "required": ["schema", "verdict", "mode", "turnBudgets", "counters"],
  "properties": {
    "schema": { "const": "terminal-repl-poc-report.v1" },
    "verdict": {
      "enum": ["PASS", "VIEW_ONLY", "PROVIDER_EXCLUDED", "ENVIRONMENT_BLOCKED", "HARNESS_FAILED", "NOT_AUTHORIZED"]
    },
    "mode": { "type": "string" },
    "detail": { "type": "string" },
    "turnBudgets": { "type": "object" },
    "counters": { "type": "object" }
  }
}
```

</Let>

<Test name="A literal REPL message reaches a native Codex pane and is confirmed" timeout="30min">

```sh timeout=25min exec as="run"
deno run --allow-all packages/terminal-tmux/poc/repl/live-supervisor.ts codex
```

The supervisor returns a structured report and exits zero even when it refuses, so
a nonzero exit means the supervisor itself broke rather than a question being
answered.

<AssertEquals actual={run.exitCode} expected={0} />

<Parse schema={reportSchema} as="proof">
{run.stdout}
</Parse>

The whole report is shown before anything is judged.

```json
{run.stdout}
```

<Switch value={proof.verdict}>
<Case value="PASS">

The exact marked message was accepted under the intended native identity and the
turn completed, observed from Codex's own rollout file and never from the screen.

<AssertEquals actual={proof.counters.wrongPaneDeliveries} expected={0} />
<AssertEquals actual={proof.counters.busyAdmissions} expected={0} />
<AssertEquals actual={proof.counters.manualActivityAdmissions} expected={0} />

</Case>
<Case value="NOT_AUTHORIZED">

The ordinary path: without both gates nothing started and no turn was spent. This
is the pass on a developer machine and in CI.

<AssertEquals actual={proof.turnBudgets.codexSpent} expected={0} />

</Case>
<Case default>

<Fail message={`The Codex live journey did not pass: ${proof.verdict} — ${proof.detail}`} />

</Case>
</Switch>

</Test>
