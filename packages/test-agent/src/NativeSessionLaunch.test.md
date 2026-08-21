# Native session launch through the test agent

`<Session.Launch>` prepares a provider session, hands it to that agent's own
native UI, and waits. This document is the authored account of that journey:
the same components a real document would write, against an agent whose
"native UI" records what it was asked to start instead of taking over the
terminal.

The scenario beside this document holds exactly one prompt stage. That is the
load-bearing detail. A launch that quietly spent a model turn would consume
that stage, and the `<Prompt>` further down would find the scenario exhausted —
so "the launch took no turn" is proven by the answer that arrives afterwards,
not by an absence nobody can see.

`xmd test` reads its argument as a path, not as a document reference, so the
section is named with `--target` rather than with a `#`. Run it with:

```sh
deno task xmd test packages/test-agent/src/NativeSessionLaunch.test.md --target Implementor --raw
```

## Implementor

<TestAgent>
<TestAgent.Scenario src="NativeSessionLaunch.scenario.md" session="implementor" />

<Test name="A launched session comes back, still holding its turn">

The session is established carrying the instruction layer prepared from this
body, and ownership moves to the native UI. Nothing here names an executable, a
session identity, or a command: those are the adapter's, and a document that
had to state them would be stating host configuration.

The session is named on the launch itself rather than by an enclosing
`<Session>`. `<Session>` establishes its session eagerly, before its body runs,
which fixes the instruction layer at nothing — and no provider replaces a layer
on a session that already exists. Naming the session here is what lets the
launch be the thing that establishes it.

<Session.Launch session="implementor">
You are the repository implementor. Follow the approved plan.
</Session.Launch>

Reaching this line is already a result. `<Session.Launch>` returns nothing to
the document on purpose — a session identity and an executable are the
provider's business, not authored values — so what it reports is whether the
whole handoff happened. A refusal, a launch that never released ACP ownership,
or a native process that exited badly would each have failed this test here.

### The scenario still has its turn

Now the part the launch could have broken. This prompt names the same session
the launch was made in, and the scenario answers it only if no earlier turn
consumed the stage.

<Prompt as="answer" session="implementor">what changed?</Prompt>

<AssertEquals actual={answer.trim()} expected={"nothing yet"} />

An exhausted scenario would have failed this prompt instead of answering it, so
one answer proves both halves at once: the launch spent no model turn, and the
session it returned is the one this prompt reached.

</Test>
</TestAgent>

## Claimed

The other half of naming the session on the launch: what happens when an
enclosing `<Session>` names it instead.

`<Session>` establishes its session before its body expands, and establishing
it through ACP is how that conversation was constructed. A session is
constructed once and never converts, so by the time the `<Session.Launch>`
inside it runs, the launch is asking to take over a conversation it did not
create — and for a client-allocated agent like Claude, whose native UI creates
the conversation itself, there is nothing to take over *to*. The launch is
refused as `identity-unavailable`, before an identity is allocated, before
exclusive ownership is even asked for, before ACP ownership is released, and
before any child.

This target exists to be refused, which is the only honest way to show what
that refusal does to the test containing it. Unlike the journey above it uses
no `<TestAgent>`: the refusal is a fact about a client-allocated provider, so
`packages/test-agent/tests/native-launch.test.ts` supplies one and reads both
the result and what was retained.

<Agent>
<Test name="A launch inside an enclosing Session is refused">

<Session name="claimed">
<Session.Launch>
You are the repository implementor. Follow the approved plan.
</Session.Launch>
</Session>

</Test>
</Agent>

## Reviewer

This section exists to be left alone. Selecting the `Implementor` target must
execute the preamble and that target's subtree and nothing else, so a sibling
that would fail if it ever ran is the honest way to prove it.

<Test name="A sibling target does not execute">
<Assert expr={false} />
</Test>
