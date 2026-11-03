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
working directory. The runner generates unique local A/B/C Session names. The maximum is six Prompts,
one attempt each: seed A, recall A, independent B, reconnect A, cancel C, then
recall A from another OS invocation. Turns have 60 seconds; the cancellation
request targets the still-active C turn after five seconds. Teardown observation
has 30 seconds and the outer work deadline has 600 seconds. Expiry ends admission;
the actual owner still joins. No uncertain turn is retried.

The runner computes setup dependencies before provider work. Continuity,
separation, reconnect and resume require one completed A seed. Only selected
continuity adds A's second turn; separation adds independent B. Cancellation
needs no marker scenario. Selecting reconnect or resume authorizes their seed
setup, even when the setup capability rows are unselected.

The checked-in initial document keeps one provider and A Session alive for the
seed and recall, then tests B. Reconnect opens a new same-process invocation.
Cancellation owns a separate document; its five-second interval begins at actual
transport-confirmed start and structured cancellation joins that document. Resume uses one
separate CLI invocation and ordinary retained A history. Its private comparison
file is neither provider history nor continuation authority.

Ordinary production validation, including its cached availability probe, remains
in force. After successful owner settlement independent stages can proceed even
though exact native closing is unverified. Pending joins, actual teardown failure
or production ownership refusal stop admission. A marker failure preserves earlier
basic/settings evidence and permits independent cancellation. No capability passes
from configuration, availability, process exit or matching display names.

From the private working directory, use absolute paths for the checked-in document,
component directory, local configuration and report:

```sh
xmd run /checkout/examples/agent-certification/certify.md --include /checkout/examples/agent-certification/components --props-config /private/local-agent.json --props-report /private/capabilities.json --deny-all --timeout 600s --raw
```

The same command through this source checkout is `deno task xmd run ...`.
Ordinary CI exercises controlled agents without credentials or model calls.

## Read the report

The current JSON format is closed and unversioned. Each of thirteen capability rows
records selected and expected flags, an outcome, a fixed reason and bounded facts.
`pass`, `failure`, `unsupported` and `not_run` are distinct. An absent selector is
unsupported; a selection the target Session does not apply is a failure. Omitted
model/effort settings supply no explicit-selection evidence.

`complete=false` includes missing provenance and selected evidence blocked by
prerequisites. A measured unsupported capability is a non-pass. Overall success
requires complete evidence and all selected/expected capabilities passing.
Acceptance and native identity are separate rows: a standard command can pass
basic authentication, streaming and completion while acceptance is
`unsupported/acceptance-unavailable` and identity is unsupported. An actual native
assertion can pass identity independently. Only a strong-declared adapter's gated
started event proves acceptance; marker-like output from a literal command does
not. Durable certification additionally requires acceptance, identity, continuity, separation, reconnect,
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
A literal command uses standard ACP without the private acceptance barrier.
Sequential prompts share the live Session; later reopening loads the exact ACP
identity if supported and refuses otherwise. Interrupted requests are never
automatically resent. Strong-declared adapters retain their acceptance barrier.

Kimi's selected live scope uses `kimi acp`, provider-default model and effort,
and no retries. A later useful live run requires changed-source review, exact fingerprints and
a fresh explicit selected-scenario grant. The earlier zero-Prompt attempt is
retained invocation evidence only; it establishes no capability battery. Gemini was absent on PATH in prepared observations; its sample command is a placeholder for the installed adapter's documented command and is
configuration syntax, not availability or certification evidence. This delivery
authorizes zero Gemini live calls and installs no agent.

The terminal matrix always lists all thirteen capabilities with selected/expected flags,
outcomes and fixed reasons, plus observed Prompt/cancellation counts and overall
flags. Failure preserves earlier independent rows and a meaningful nonzero status.
Private markers, replies, Session identities and child fragments remain local.

Prompt counts describe turns observed through the production stream. A refusal
before stream disclosure can leave native submissions unobserved; these counts
are not billing evidence. Resume follows its own CLI work deadline and the parent
waits for actual process settlement even if outer work is cancelled.

The 30-second teardown observation begins when an element's own work exits,
before its resources close. Expiry permanently ends later admission even if
cleanup subsequently succeeds; the runner still waits for the real join. The
same observation runs inside the resume child. Demonstrated invocation teardown
failure remains failure/cleanup-failed after later successful joins.
