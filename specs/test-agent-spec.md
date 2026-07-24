# Executable.md ACP Test Agent

**Status:** Implemented\
**Related:** [Executable.md ACP Client](./acp-client-spec.md)

## Purpose

The ACP Test Agent is a simulated test agent used for black box testing of
Executable.md agent integration. ACPX provider starts the test agent instead
of coding agents like Claude Code and Codex to simulate prompt responses
provided by these agents.

The test harness provides a markdown document that describes the behaviour of
the agent and its state. The subprocess itself is stateless, it accepts the
markdown document and a journal of the markdown agent state. This journal is
used to forward the markdown document to the state where the last execution
was stopped. The execution resumes from the last entry in the journal.

This arrangement tests the complete boundary:

```text
test document
    -> Agent Context API
    -> ACPX
    -> xmd test-agent
    -> behavior document
```

It does not start a probabilistic coding agent.

## TestAgent

`<TestAgent>` installs the controlled ACPX provider for its body and owns the
controller that serves behavior documents to agent subprocesses:

```text
<TestAgent>
  <TestAgent.Scenario
    agent="test"
    session="review"
    src="./agents/review.md"
  />

  <Test name="reviews a change">
    <Agent name="test">
      <Session name="review">
        <Prompt>Review packages/core at revision abc123</Prompt>
      </Session>
    </Agent>
  </Test>
</TestAgent>
```

`<TestAgent>` is valid only in an active testing session created by `xmd test`
or `useTesting()`. Using it outside a testing session is a configuration error.
The controller starts lazily when the component expands and stops with its
scope.

The default agent name is `test`. An `agent` prop changes that default:

```md
<TestAgent agent="reviewer">
  ...
</TestAgent>
```

A scenario without an `agent` prop inherits the resolved default. An explicit
scenario agent registers an additional agent. The default does not depend on how
many agents are registered.

Scenario declarations render no output and must expand before a test uses them.
A declaration maps an agent and logical session to a behavior document:

```text
(agent, logical session) -> behavior document
```

An omitted `session` maps only the unnamed default session. It is not a
wildcard. A named `<Session>` requires an exact named mapping. A missing or
duplicate mapping fails the owning test before its agent turn starts. An unused
mapping does not fail the test-agent scope.

The test runtime does not inject agent, session, cwd, or harness metadata into
the behavior document. The document sees its own frontmatter and bindings,
including values captured by prompt matchers.

## Scenario instances

A scenario declaration is a blueprint, not a singleton runtime. Each resolved
ACP session receives an isolated behavior-document instance and journal.

Within one test, `(agent, logical session, cwd)` identifies one resumable
instance. Repeated prompts to that session advance the same document. Different
sessions and working directories have independent state.

Each `<Test>` receives fresh ACPX state, document instances, and journals even
when it uses the same scenario declaration and keys as another test. When
`<TestAgent>` is used without an enclosing `<Test>`, its own scope is the
isolation boundary.

A scenario instance may remain suspended at a prompt matcher when its scope
ends. Structured teardown halts and awaits the instance; it does not require the
document to reach EOF and does not report unconsumed stages.

## Behavior documents

A behavior document is a declarative sequence of prompt stages. Each stage
starts with `<WhenPrompt>`. Markdown rendered after a successful match and
before the next matcher is the text response for that prompt.

```md
<WhenPrompt
  as="review"
  template="Review {?subject} at revision {?revision}"
/>

The review of **{review.subject}** at `{review.revision}` passed.

<WhenPrompt template="Summarize {review.subject}" />

The review of **{review.subject}** passed.
```

The runtime expands the document until it reaches a `<WhenPrompt>`, then
suspends. An incoming ACP prompt is offered to that matcher:

- A match advances the document and makes captured values available.
- Rendering continues until the next `<WhenPrompt>` or EOF.
- Reaching the next matcher implicitly completes the current turn with
  `end_turn` and suspends the document there.
- EOF completes the final turn with `end_turn`.
- A prompt received after EOF fails with a `scenario exhausted` diagnostic.

Every incoming prompt must match the active stage. Prompts are never silently
ignored or dismissed. A mismatch fails the ACP turn and the owning `<Test>` so
ACPX cannot remain waiting. The diagnostic includes the expected template and
the actual prompt.

## WhenPrompt templates

`<WhenPrompt>` accepts a single-line `template` prop or rendered children for a
multiline template. Supplying both forms is a configuration error.

Templates match the complete prompt. Literal text is a constraint. Two forms of
interpolation are available:

- `{?name}` captures prompt text.
- `{binding}` interpolates an existing value and requires the prompt to contain
  that value at the same position.

Captures require an `as` prop. They are stored as strings in one flat object
under that binding:

```md
<WhenPrompt
  as="review"
  template="Review {?subject} at revision {?revision}"
/>
```

This produces `review.subject` and `review.revision`. A subsequent stage can
constrain the prompt with those values:

```md
<WhenPrompt template="Summarize {review.subject}" />
```

`as` is optional when the template has no captures. An unresolved ordinary
binding is a configuration error and never becomes an implicit capture. Repeated
uses of one capture name must match the same text. Adjacent capture holes
without literal text between them are rejected as ambiguous.

## Controller and worker

The controller owns:

- scenario registration and resolution;
- per-test ACPX configuration and state;
- behavior-document instances and journals;
- a virtual filesystem containing each behavior document and its permitted
  dependencies;
- failures reported to the owning test.

The public worker command is:

```text
xmd test-agent --connect <opaque-controller-route>
```

It appears in CLI help and operates only as a controller-launched worker. It
does not accept a standalone behavior-document argument.

The opaque route identifies the controller and the resolved scenario instance.
This control-plane identity is established before ACPX starts the process
because ACP does not carry Executable.md's logical session name. Public agent
and session values remain unchanged; ACPX-facing route names are internal.

The worker connects to the controller, receives the root document, permitted
dependencies, and current journal, rehydrates the document, and serves ACP over
stdin and stdout. It supports the successful ACP lifecycle used by ACPX:

- initialize;
- create a session;
- load or resume a session;
- prompt;
- cancel.

An agent availability check starts a disposable worker, completes ACP
initialization, and closes it. Starting a session may start a separate worker.
Successful validation therefore proves that the configured test agent is
available without promising a prewarmed process.

The lifecycle is:

```text
xmd test
  |
  | expand <TestAgent> and register scenarios
  | configure ACPX to launch xmd test-agent
  v
ACPX availability probe
  | start -> initialize -> close disposable worker
  v
test prompt
  | resolve agent + logical session + cwd
  | allocate isolated scenario instance and opaque route
  | ensure ACPX session
  v
xmd test-agent
  | connect to controller
  | receive behavior document + journal
  | replay to active <WhenPrompt>
  | initialize and create/load/resume ACP session
  v
ACPX sends prompt
  | match active stage
  | render response to next stage or EOF
  | persist transition
  v
ACPX returns text and end_turn
  |
  v
test scope teardown
  | cancel active turn
  | close ACPX provider and worker
  | halt and await behavior runtime
  | discard isolated state
```

## Replay and journals

Behavior journals are private to the test-agent controller and separate from the
document-under-test journal. Each isolated scenario instance has one journal
containing the matched prompt, captures, and completed stage transitions.

Restart recovery covers crashes between completed turns; a crash inside a
turn's final delivery window is outside the supported guarantee. When a
worker restarts or ACPX resumes its session, the controller supplies the
same behavior document and journal. Replay restores captures and advances
execution to the active `<WhenPrompt>` without requiring mutable state in the
worker.

The behavior journal exists only for the lifetime of its isolation boundary and
is discarded during teardown. Verbose diagnostics may report stage transitions
and failures, but behavior records do not appear in the main xmd journal.

The main journal retains the ACP client's normal durability semantics. Replaying
a completed prompt restores its recorded text and outcome without starting ACPX
or a test-agent worker.

## Deterministic runtime

Behavior documents run with a deterministic test profile:

- frontmatter, components, imports, eval state, interpolation, and matcher
  captures are available;
- process and network access are denied by default;
- `cwd()` is supplied through the contextual cwd API and returns the virtual
  scenario-directory root; `env()` returns undefined;
- the filesystem is limited to controller-backed Markdown reads and stats
  beneath the scenario directory; other filesystem operations are denied;
- dependencies are Markdown components only. Normal component-candidate
  order is preserved: an earlier Name.md wins; if Name.ts exists when
  reached, the worker immediately raises the unsupported-TypeScript error;
  if Name.ts is missing, resolution continues to later candidates such as
  Name/index.md. `.ts` files are never read, materialized, or imported;
- eval blocks are inline-only: static and dynamic module imports are
  rejected before compilation, while inline eval state and Context API
  access remain available. Arbitrary eval code is trusted — this profile is
  a capability policy, not a security sandbox;
- whitespace-only output before the first `<WhenPrompt>` is allowed;
  rendering output whose trimmed text is non-empty before the first matcher
  is a configuration error;
- explicitly scoped Context middleware may provide additional controlled
  capabilities.

The worker never reads the shared workspace directly.

## Failure and teardown

Configuration, matcher, controller, worker, and ACP protocol failures fail the
owning `<Test>`. A turn failure is also returned through ACP so the client can
finish rather than hang.

Teardown cancels active turns, closes ACPX, stops workers, and halts behavior
runtimes. It attempts every cleanup step. Multiple cleanup failures are reported
with `AggregateError`.

## Acceptance tests

The essential acceptance coverage is:

1. Component and Context API tests verify default and named mappings, duplicate
   and missing mappings, test isolation, cwd isolation, whole-prompt matching,
   captures, constraints, mismatch diagnostics, scenario exhaustion, and clean
   suspension at teardown.
2. A worker lifecycle test verifies initialize, create, load or resume, prompt,
   cancellation, restart, and behavior-journal rehydration through the ACP
   transport.
3. The existing CI smoke runner executes one document through `xmd test`, the
   real ACPX runtime, `xmd test-agent`, and a behavior document. It covers
   availability, session creation, prompt matching, rendered text, and provider
   teardown.
4. The smoke runner replays the completed main journal and verifies the same
   result without contacting ACPX or the worker.

Unit tests use direct Context API and controller fixtures for edge cases that do
not benefit from crossing the ACPX process boundary. CI does not start an
external coding agent.

## Not included

This interface does not include:

- regular-expression matchers;
- repeating or non-advancing matchers such as `<UntilPrompt>`;
- ignored intermediate prompts;
- response fragments or raw ACP event scripting;
- injected lifecycle failures or custom stop reasons;
- public access to behavior journals;
- a standalone `xmd test-agent <scenario>` mode;
- agent, session, cwd, or harness metadata injected into behavior documents.
