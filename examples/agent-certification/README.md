# Qualify a locally configured ACP agent

Use one local JSON configuration for qualification and ordinary orchestration.
The command reaches XMD's production ACPX provider as a literal command; no agent
registry edit is needed. Another agent changes configuration rather than copying
this workflow.

Prepare this checkout with `deno task setup`. Install and authenticate your agent
separately. Copy `kimi.example.json` outside this checkout and edit its command
and expectations. Keep credentials in the agent's existing local authentication;
the configuration accepts no credentials or environment map. ACPX's raw command
resolution has platform limits on Windows; this example adds no launcher or
registry to change them.

## Authorize one bounded run

Selecting a scenario authorizes its model turns and cancellation of the suite's
own test turn. Live execution is opt-in and may cost money. Use a fresh private
working directory and unique local Session names. The maximum is six Prompts,
one attempt each: seed A, recall A, independent B, reconnect A, cancel C, then
recall A from another OS invocation. Turns have 60 seconds; the cancellation
request targets the still-active C turn after five seconds. Teardown observation
has 30 seconds and the outer work deadline has 600 seconds. Expiry ends admission;
the actual owner still joins. No uncertain turn is retried.

The existing production availability probe releases a native child before it
returns. XMD cannot verify exact native closing from that settlement. This
example therefore stops admission at that preliminary boundary, before Prompt 1.
Reconnect, cancellation and later invocation work remain not run. Selecting those
scenarios does not bypass the stop. No capability passes from configuration,
availability, process exit or retained display metadata.

From the private working directory, use absolute paths for the checked-in document,
component directory, local configuration and report:

```sh
xmd run /checkout/examples/agent-certification/certify.md --include /checkout/examples/agent-certification/components --props-config /private/local-agent.json --props-report /private/capabilities.json --deny-all --timeout 600s --raw
```

The same command through this source checkout is `deno task xmd run ...`.
Ordinary CI exercises controlled agents without credentials or model calls.

## Read the report

The current JSON format is closed and unversioned. Each of eleven capability rows
records selected and expected flags, an outcome, a fixed reason and bounded facts.
`pass`, `failure`, `unsupported` and `not_run` are distinct. An absent selector is
unsupported; a selection the target Session does not apply is a failure. Omitted
model/effort settings supply no explicit-selection evidence.

`complete=false` includes missing provenance and selected evidence blocked by
prerequisites. A measured unsupported capability is a non-pass. Overall success
requires complete evidence and all selected/expected capabilities passing.
Durable certification additionally requires continuity, separation, reconnect,
separate-invocation resume and verified cleanup. Native cleanup remains
`not_run/cleanup-unverified` after a successful owner join; actual observed cleanup
failure is failure. Correct stop attribution alone cannot pass cancellation.

Only categorical values, booleans, counts, strict version tokens, fixed platform
facts and fingerprints enter this report. Missing executable/adapter/runtime
provenance remains null and prevents complete evidence. Configuration and source
fingerprints identify exact noncredential inputs; no digest is invented. The
report contains no prompts, replies, private marker, credential, environment
value, path, command, raw identifier, exception or provider output.

Your agent can retain private native history under its normal policy. XMD's
optional diagnostic journal is also private and is not this report or continuation
input. Neither certification nor a report grants durable identity or tools.

## Use the same local configuration

Ordinary orchestration uses the same command and exact optional model/effort IDs:

```sh
xmd run /checkout/examples/agent-certification/orchestrate.md --include /checkout/examples/agent-certification/components --props-config /private/local-agent.json --props-prompt 'Summarize this task without tools.' --deny-all --raw
```

This is a separate explicitly requested model call, outside the qualification
suite. Ordinary name/cwd retention is not workflow Session-site identity.
The existing backend first-turn acceptance barrier remains mandatory; an
unpatched adapter can be refused even after producing output.

Kimi's selected live scope uses `kimi acp`, provider-default model and effort,
and no retries. The retained workflow runs it only after review and exact
fingerprints. Gemini was absent on PATH in prepared observations; its sample command is a placeholder for the installed adapter's documented command and is
configuration syntax, not availability or certification evidence. This delivery
authorizes zero Gemini live calls and installs no agent.
