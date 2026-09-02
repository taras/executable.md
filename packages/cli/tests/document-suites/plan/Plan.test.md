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

<Test name="a document captures its approved Plan" timeout="120s">

The child is `uses-plan.md`, which writes `<Plan>` and prints what it bound. The
scenario answers the one request the Plan workflow sends, and the answer
approves the draft it produced.

The child authors `session="planner"`, and its scenario names that exact label.
The trusted child host privately connects the declaration to the opaque
conversation identity `<Plan>` derives for this invocation; the provider keeps
all runtime state under that opaque identity.

<Execution host="run" target="packages/cli/tests/document-suites/plan/uses-plan.md" as="run">
<TestAgent>
<TestAgent.Scenario session="planner" src="./agents/approved-plan.md" />
</TestAgent>

<Answers>
<Answer value={{ decision: "Approve" }} />
</Answers>

<CollectOutput as="output" />

<AssertEquals actual={run.result.ok} expected={true} />
<AssertStringIncludes actual={output} expected="# Approved program" />
<AssertStringIncludes actual={output} expected="the approved Plan ran" />
</Execution>
</Test>

## An approved Plan is source, not something that ran

The program this scenario approves names a file. Approving it hands the source
back; it does not run it. The file is therefore the evidence: a child that
executed what it was given would have created it.

<Test name="the approved source did not run" timeout="120s">
<Execution host="run" target="packages/cli/tests/document-suites/plan/uses-plan.md" as="run">
<TestAgent>
<TestAgent.Scenario session="planner" src="./agents/approved-plan.md" />
</TestAgent>

<Answers>
<Answer value={{ decision: "Approve" }} />
</Answers>

<CollectOutput as="output" />

<AssertEquals actual={run.result.ok} expected={true} />
<AssertStringIncludes actual={output} expected="the approved Plan ran" />
</Execution>

The source arrived, and the file it names is nowhere: the child ran in this
working directory, so a child that executed what it was given would have written
it here.

<Glob include={["planned.txt"]} as="written" />
<AssertEquals actual={written.length} expected={0} />
</Test>

## Without a scripted agent there is no Agent to write with

`<Plan>` asks its host for an Agent context before it makes a directory, starts a
conversation or asks anybody anything. A child nobody configured has none to
give, so it is refused there — not given a live coding agent, and not told the
component does not exist.

<Test name="an unconfigured child is refused before anything is prepared" timeout="120s">
<Execution host="run" target="packages/cli/tests/document-suites/plan/uses-plan.md" as="run">
<CollectOutput as="output" />

<AssertEquals actual={run.result.ok} expected={false} />
<AssertEquals
  actual={run.result.error.message}
  expected="No Agent context was found. No Plan was returned."
/>
<AssertEquals actual={output.includes("# Approved program")} expected={false} />
</Execution>
</Test>
