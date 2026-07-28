# Deterministic agent tests

## Why use a scripted test agent?

A real coding agent is nondeterministic, can be slow or network-dependent, and
does not make a good source of exact assertions. The test agent gives your
workflow controlled replies, so you can verify prompts, session continuity,
captures, routing, and failure handling predictably.

It tests the Executable Markdown-to-ACPX integration and the way your document
orchestrates an agent. It does not prove that a real model reasons well, writes
the same text, or has the expected tools installed.

For a real-agent workflow, see the [coding-agent guide](https://executable.md/docs/agents).

## When to use it

Use the test agent to verify:

- The prompt your workflow sends.
- A multi-turn session.
- How a captured reply is used later.
- Agent and session routing.
- Failure handling.
- The real ACPX boundary without invoking a model.

Do not use it to measure model quality or to assert exact behavior from a real
agent.

## Write one useful test

Keep the application test and the controlled reply in separate files. The test
document describes the workflow you are shipping; the scenario describes the
agent response it expects.

`tests/agent-integration.md` sends a review prompt, keeps the follow-up in the
same session, and asserts the captured replies:

```md
<TestAgent>
  <TestAgent.Scenario agent="test" session="review" src="./agents/review.md" />

  <Test name="reviews a change">
    <Agent name="test">
      <Session name="review">
        <Prompt text="Review packages/core at revision abc123" as="firstReply" />
        <Prompt text="Summarize packages/core" as="secondReply" />
      </Session>
    </Agent>
    <AssertStringIncludes actual={firstReply} expected="The review of **packages/core** at `abc123` passed." />
    <AssertStringIncludes actual={secondReply} expected="The review of **packages/core** passed." />
  </Test>
</TestAgent>
```

`tests/agents/review.md` supplies the expected prompts and replies:

```md
<WhenPrompt
  as="review"
  template="Review {?subject} at revision {?revision}"
/>

The review of **{review.subject}** at `{review.revision}` passed.

<WhenPrompt template="Summarize {review.subject}" />

The review of **{review.subject}** passed.
```

Run the test:

```sh
xmd test tests/agent-integration.md
```

The test passes when the document sends both expected prompts, the second prompt
continues the review session, and each captured reply satisfies its assertion.
`<TestAgent>` creates the controlled agent for its body and closes it when the
test ends.

## Read the scenario through the example

`<WhenPrompt>` means “expect this incoming prompt.” It is not a prompt sent by
the scenario. Its following Markdown becomes the controlled reply, until the
next `<WhenPrompt>` begins another expected turn.

The first expected prompt captures the subject and revision because the second
reply needs to remember the subject. `{?subject}` captures incoming text;
`as="review"` makes it available as `{review.subject}` later. Literal text in a
template is a constraint, so an accidental prompt change fails rather than
silently matching.

By default, `<TestAgent>` uses the agent name `test`; a scenario without an
`agent` attribute uses that default. A scenario without a `session` maps only
the unnamed session, not every named session. Each test and each working
directory receive independent scenario state, even when they use the same
mapping. A test may finish with later scenario stages unused.

## Use a failure to fix the workflow

If the document sends this instead:

```md
<Prompt text="Review packages/core" />
```

the test fails with the expected template and the actual prompt. Compare those
two values first. They identify a changed prompt, a missing captured value, a
wrong agent or session, or a scenario stage that was already consumed. A prompt
after the final stage reports `scenario exhausted`.

Missing or duplicate scenario mappings, malformed scenarios, and unsupported
setup fail the owning test before an unreliable later assertion can obscure the
problem.

## Test another ACP client directly

Use this advanced path when developing another ACP client, inspecting the ACP
boundary independently of `xmd test`, or debugging controller and worker
integration.

The existing `examples/review.md` is the scenario above. Start its walkthrough
controller from this checkout:

```sh
deno run --allow-all packages/test-agent/examples/acpx-walkthrough.ts
```

It prints two complete commands. Copy the exact lines into another terminal and
run them in order. The controller fills in its route and the checkout's absolute
CLI source path:

```sh
acpx --agent "deno run --allow-all '<abs>/packages/cli/src/deno.ts' test-agent --connect <route>" exec "Review packages/core at revision abc123"
acpx --agent "deno run --allow-all '<abs>/packages/cli/src/deno.ts' test-agent --connect <route>" exec "Summarize packages/core"
```

If an appropriate `xmd` binary is already on your `PATH`, its equivalent agent
command is `xmd test-agent --connect <route>`. The controller still supplies
the route and scenario state, and the worker has no standalone scenario-file
mode. Each `acpx exec` uses a temporary session; the second command still sees
the first capture because the controller restores completed scenario stages for
the worker.
