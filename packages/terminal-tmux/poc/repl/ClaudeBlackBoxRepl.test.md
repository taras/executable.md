# Black-box REPL messaging to a native Claude pane

`xmd run` can open a Claude coding agent in a terminal pane. This document asks
the one question the POC exists to answer for Claude: **can generic terminal-state
convergence deliver one literal REPL message into that pane, and can Claude's own
session file confirm the exact message was accepted and answered — without any
hook, plugin, or screen scraping?**

The journey launches the real grid, waits for the pane's terminal to converge on a
safe input point, pastes one uniquely-marked message as literal bytes, and then
reads Claude's own session file for the exact user event and its completion. The
terminal only ever authorizes the attempt; acceptance is the provider file's word.

## What this costs, and what it touches

One Claude model turn against the operator's own credentials. It runs under a
private `HOME` and `TMPDIR`, so `.xmd`, `.acpx`, the adapters, the launch journal,
the tmux server and the POC store are isolated. `CLAUDE_CONFIG_DIR` is left as the
operator has it so Claude stays authenticated; nothing beneath Claude's
configuration or history is swept. Claude's project state for the temporary
directory is cleaned afterward through Claude's own `project purge`.

It is gated twice over. Without `XMD_TERMINAL_REPL_CLAUDE_PROOF=1` and
`XMD_TERMINAL_REPL_CLAUDE_MODEL_TURNS_AUTHORIZED=1`, the supervisor refuses before
any agent starts and before any transcript is opened, printing a `NOT_AUTHORIZED`
report that spent nothing. That is the branch that runs on an ordinary machine and
in CI.

Run it, once authorized, with:

```sh
XMD_TERMINAL_REPL_CLAUDE_PROOF=1 XMD_TERMINAL_REPL_CLAUDE_MODEL_TURNS_AUTHORIZED=1 \
  deno task xmd test packages/terminal-tmux/poc/repl/ClaudeBlackBoxRepl.test.md --raw
```

## What a verdict may say

The report carries versions, hashes, counters, turn budgets and cleanup outcomes,
and no conversation: no transcript, no reply, no path, no argv, no environment, no
tmux identifier, and no raw native identity.

<Let as="reportSchema" select="code[lang=json]">

```json
{
  "type": "object",
  "required": ["report", "schemaValid"],
  "properties": {
    "report": {
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
    },
    "schemaValid": { "type": "boolean" },
    "errors": { "type": "array" }
  }
}
```

</Let>

<Test name="A literal REPL message reaches a native Claude pane and is confirmed" timeout="30min">

```sh timeout=25min exec as="run"
deno run --allow-all packages/terminal-tmux/poc/repl/live-supervisor.ts claude
```

The supervisor returns a structured report and exits zero even when it refuses, so
a nonzero exit means the supervisor itself broke rather than a question being
answered.

<AssertEquals actual={run.exitCode} expected={0} />

<Parse schema={reportSchema} as="proof">
{run.stdout}
</Parse>

The supervisor validated the report against the checked-in
`report.schema.json` — the full validator — before printing it, so an invalid
report fails here rather than being read past.

<Assert expr={proof.schemaValid} />

The whole report is shown before anything is judged.

```json
{run.stdout}
```

<Switch value={proof.report.verdict}>
<Case value="PASS">

The exact marked message was accepted under the intended native identity and the
turn completed, observed from Claude's own session file and never from the screen.

<AssertEquals actual={proof.report.counters.wrongPaneDeliveries} expected={0} />
<AssertEquals actual={proof.report.counters.busyAdmissions} expected={0} />
<AssertEquals actual={proof.report.counters.manualActivityAdmissions} expected={0} />

</Case>
<Case value="NOT_AUTHORIZED">

The ordinary path: without both gates nothing started and no turn was spent. This
is the pass on a developer machine and in CI.

<AssertEquals actual={proof.report.turnBudgets.claudeSpent} expected={0} />

</Case>
<Case default>

<Fail message={`The Claude live journey did not pass: ${proof.report.verdict} — ${proof.report.detail}`} />

</Case>
</Switch>

</Test>
