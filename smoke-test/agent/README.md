# Agents through `xmd run`

This document verifies that an ordinary Markdown document can drive an agent
through `xmd run`. It is the parent test harness: it starts the supporting
infrastructure, runs child `xmd run` commands, and asserts what they rendered.

## The boundary under test

Everything below exercises one path end to end:

```text
Markdown harness
  → compiled xmd run
  → ordinary <Agent>/<Session>/<Prompt> document
  → ACPX
  → compiled xmd test-agent
  → behavior document
```

The integration path is real and the agent's judgement is not. ACPX is the
production runtime. `xmd run` and `xmd test-agent` are the compiled binary,
started as separate processes. ACP initialization, session creation, prompts,
streamed output and teardown all cross the real process and protocol
boundaries.

What is deliberately replaced is the agent's decision-making: instead of a
coding agent choosing what to say, the process on the far end answers from a
behavior document. That substitution is the point — it makes the transport
observable and the assertions stable — but it means this test proves the
integration works, not that any particular agent behaves well.

## The pieces and why each exists

**The child documents** — [first-turn.md](./first-turn.md),
[second-turn.md](./second-turn.md) and [mismatch.md](./mismatch.md) — use only
the ordinary agent API: `<Agent>`, `<Session>` and `<Prompt>`. They contain no
testing wrapper and no provider component, because the point is that an everyday
document needs nothing special to talk to an agent.

**The behavior document** — [scenario.md](./scenario.md) — is the test double.
A coding agent answers differently every time, so the process on the other end
of the protocol is `xmd test-agent`, which replies by advancing through that
document's `<WhenPrompt>` stages. The responses are fixed, so a wrong answer is
a test failure rather than noise.

**The controller** exists because the worker needs to be told which behavior
document to serve. `xmd test-agent` connects back to a controller over a
loopback route and receives its scenario and journal from it. The route is
generated per run, so the harness has to create the controller, register the
scenario and hand the resulting route to the child command.

**Both commands use the compiled binary.** The parent runs from `./dist/xmd`,
and the agent command it passes to the child names `./dist/xmd` too. Source-mode
runs would leave the compiled artefact untested, and it is the compiled binary
that ships — including its ability to relaunch itself as a worker.

## How the agent is selected

ACPX treats an agent name it does not recognise as the command to run. The
harness exploits that: it passes the route-backed worker command itself as
`--default-agent`, so no released package, global install or coding agent needs
to be present.

`<AgentHarness>` below owns the controller, the registered scenario and an
isolated `HOME`, keeps them alive while its body runs, and releases them
afterwards. It publishes what the body needs as `{harness.binary}`,
`{harness.agent}` and `{harness.home}`. The isolated `HOME` matters because ACPX
stores session state under it, and this test must not read or write the
developer's own.

## Why running twice proves teardown

The controller admits one worker per scenario at a time. A second run can only
attach if the first run's provider released its worker before the process
exited — so a follow-up run that succeeds is direct evidence of teardown, in a
way that waiting for a timeout is not.

That gives two proofs, and each needs its own scenario: a behavior document
advances as prompts match it, so the two paths run under separate
`<AgentHarness>` blocks rather than sharing one that has already moved on.

Every child command runs inside an executable block, so each is bounded by the
block execution timeout. Each block records the child's exit status the moment
it finishes and prints it as `status=[N]`. The delimiters matter: a bare `1`
would also match `10` or `127`, so a missing binary or a crash could otherwise
pass for the failure the test expects.

## The successful path

The first run answers from the scenario's opening stage. The second run is the
teardown proof: it attaches to the same controller and route, and advances to
the next stage.

<AgentHarness scenario="smoke-test/agent/scenario.md">

<Test name="an ordinary document reaches the agent through xmd run">
<Capture as="firstRun">
```bash exec
HOME="{harness.home}" "{harness.binary}" run smoke-test/agent/first-turn.md \
  --default-agent "{harness.agent}" --raw
status=$?
echo "status=[$status]"
```
</Capture>
<AssertStringIncludes actual={firstRun} expected="The review of **packages/core** at `abc123` passed." />
<AssertStringIncludes actual={firstRun} expected="status=[0]" />
</Test>

<Test name="a second run attaches again and advances the scenario">
<Capture as="secondRun">
```bash exec
HOME="{harness.home}" "{harness.binary}" run smoke-test/agent/second-turn.md \
  --default-agent "{harness.agent}" --raw
status=$?
echo "status=[$status]"
```
</Capture>
<AssertStringIncludes actual={secondRun} expected="The review of **packages/core** passed." />
<AssertStringIncludes actual={secondRun} expected="status=[0]" />
</Test>

</AgentHarness>

## The failure path

A prompt the scenario does not describe fails the run. Because a mismatch is
transactional it consumes no stage, so the run that follows should still find
the opening stage — and can only reach it at all if the failed run released its
worker on the way out.

<AgentHarness scenario="smoke-test/agent/scenario.md">

<Test name="an unmatched prompt fails the run">
<Capture as="mismatchRun">
```bash exec
HOME="{harness.home}" "{harness.binary}" run smoke-test/agent/mismatch.md \
  --default-agent "{harness.agent}" --raw
status=$?
echo "status=[$status]"
```
</Capture>
<AssertStringIncludes actual={mismatchRun} expected="status=[1]" />
</Test>

<Test name="a matching run after a failure attaches and finds its stage intact">
<Capture as="recoveredRun">
```bash exec
HOME="{harness.home}" "{harness.binary}" run smoke-test/agent/first-turn.md \
  --default-agent "{harness.agent}" --raw
status=$?
echo "status=[$status]"
```
</Capture>
<AssertStringIncludes actual={recoveredRun} expected="The review of **packages/core** at `abc123` passed." />
<AssertStringIncludes actual={recoveredRun} expected="status=[0]" />
</Test>

</AgentHarness>
