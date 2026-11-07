# Calibrate Prompt usage for one bundled Agent

Every acknowledged Agent Prompt keeps the usage its provider reported in its
canonical journal record. This experiment tells you what those numbers cover on
the build you are measuring: whether a reported total is the whole outer Prompt,
only its final internal request, or something the source cannot say. It sends a
few real Prompts through one production XMD host and compares what the journal
retained with ACPX's saved copy and with the native agent's own account.

Prepare this checkout with `deno task setup`, and install and authenticate the
native agent separately. Nothing here installs an agent or obtains credentials.

## Run one experiment

Each invocation selects exactly one host, one bundled Agent and one scenario,
and may spend tokens:

```sh
deno run --allow-all --frozen examples/agent-usage/calibrate.ts --host=source --agent=claude --scenario=success --output=/private/claude-source-success --allow-paid
deno run --allow-all --frozen examples/agent-usage/calibrate.ts --host=compiled --xmd=/absolute/path/to/xmd --agent=codex --scenario=success --output=/private/codex-compiled-success --allow-paid
```

To run another scenario, change only `--scenario`. `--output` must name a
directory that does not exist yet; an experiment never merges with or
overwrites earlier evidence. `--help` prints the grammar and starts nothing.

| Scenario | Outer Prompts | What it must show |
| --- | --- | --- |
| `success` | 2 | One Session; two separate file reads in the first Prompt, then recall without tools. |
| `resume` | 2 | A seed, a joined shutdown, then a continuation of the exact retained Session in a separate invocation. |
| `failure` | 1 | An attempted native write refused by the host under `--deny-all`. |
| `cancel` | 1 | Cancellation after the Agent said `USAGE_CALIBRATION_READY`, while its work was still active. |
| `subagent` | 1 | One native subagent where supported, or the specific gap. |

Each Prompt is attempted once. Nothing is retried, repaired or restarted, and no
other scenario runs. A later invocation starts only after the one before it exited
successfully: a host that ended unsuccessfully may have failed its own cleanup,
so the resume continuation is never started after an unsuccessful seed. Each Prompt has 60 seconds of work, and no invocation is
admitted after 300 seconds; either deadline interrupts the host's own work and
then waits for it to finish.

The scenario documents in `scenarios/` are what the host runs; read them to see
exactly what is asked. The source host is `packages/cli/src/deno.ts` from this
checkout; the compiled host is the exact `--xmd` executable. Both run with
`--journal`, so the history they write is ordinary canonical XMD history.

## Read the result

The command ends with one line:

```text
Calibration completed. Read <output>/report.md.
Calibration completed with accounting limitations. Read <output>/report.md.
Calibration incomplete. Read <output>/report.md before attempting another run.
```

`report.md` and `report.json` state the same result: the builds measured, each
acknowledged Prompt's source-labelled readings and coverage, and one row per
check — usage retained, request-to-message association, ACPX's saved copy,
the independent native comparison, the scenario's own behavior, history
readback and joined teardown. The counts separate the outer Prompts reserved
against the allowance from the submissions the evidence actually shows, which
are `unknown` when the evidence cannot account for every reservation. A native
comparison is made only with the native turn that carried this run's exact
input in the session the record names. Each row is `verified`, `limited`, `unavailable`,
`failed` or `not_run`, with a fixed reason.

A `limited` row is a measured bound, such as `final-request-only`: the reported
total matched only the last internal request of a Prompt that made several.
Agreement with ACPX's saved copy proves the transport, not that a total covers
the whole Prompt. A scenario that did not happen — reads combined, no
cancellation marker, a write never attempted — makes the run incomplete rather
than a limitation.

The shareable report holds counts, version tokens, digests, reviewed model
names and fixed reasons; no identity, path, marker, prompt or reply text. The
private files beside it — the child journals, `support/` and
`evidence-index.json` — are evidence for whoever ran the experiment, not a
second account of usage and not input to another run.
