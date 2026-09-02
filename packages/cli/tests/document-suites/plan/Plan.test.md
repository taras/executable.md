# Running `<Plan>` in a Markdown test

`<Plan>` asks a coding agent to write a program and asks a person to approve it.
Both of those are reasons a test could not run one: an agent is slow and
different every time, and a review opens a browser form somebody has to click.

A nested `<Execution host="run">` answers both. Declaring `<TestAgent>` inside it
gives that child a scripted agent, and declaring `<Answers>` gives it the review
decision, so the child document below runs the ordinary public component with
nothing in it changed for testability.

Two kinds of path appear below, and they resolve differently on purpose. A
scenario's `src` is a file this document reads, so it is written relative to this
document. A child's `target` is a document the run host resolves, so it is
written relative to the working directory — the repository root, where each
runtime starts its test process.

## The successful path is not here yet

The two rows this suite exists for — a document capturing its approved Plan, and
the approved source not having run — are not written here, because a scenario
cannot address the conversation `<Plan>` opens.

`<Plan>` places its conversation under a session it derives from the expansion
that asked for it, so `<Plan session="planner">` talks to
`xmd-plan:<64 hex digits>` rather than to `planner`. A scenario maps one exact
agent and logical session, and an omitted `session` maps the unnamed default
rather than acting as a wildcard (specs/test-agent-spec.md, "Behavior
documents"). There is therefore no name a checked-in test can write that reaches
the Plan's turn, and the child fails with `no <TestAgent.Scenario> maps agent
"test" and session "xmd-plan:…"`.

The refusal below is the part that does hold today, and it is the part that
proves the ceiling is real.

## Without a scripted agent there is no ceiling to write under

`<Plan>` establishes an agent ceiling before it makes a directory, starts a
conversation or asks anybody anything. A child nobody configured has no agent to
put under one, so it is refused there — not given a live coding agent, and not
told the component does not exist.

<Test name="an unconfigured child is refused at the Plan ceiling" timeout="120s">
<Execution host="run" target="packages/cli/tests/document-suites/plan/uses-plan.md" as="run">
<CollectOutput as="output" />

<AssertEquals actual={run.result.ok} expected={false} />
<AssertStringIncludes
  actual={run.result.error.message}
  expected="establishes no coding-agent ceiling"
/>
<AssertEquals actual={output.includes("# Approved program")} expected={false} />
</Execution>
</Test>
