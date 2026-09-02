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

## The bare form emits the program's source

Written without `as`, `<Plan>` emits the approved program where the component
appears, and what a reader of the run sees is what the agent wrote.

**This host installs no presentation middleware**, so what these two cases prove
is the raw author-facing path: which form emits, which binds, and that the bytes
arrive whole. They do not prove that the presentation an ordinary `xmd run`
installs leaves those bytes alone — nothing here would fail if it did not.
That discrimination is owned elsewhere, by cases that install the real
middleware and fail when the bypass is removed: `PC19` in
`packages/cli/tests/plan-component.test.ts` for whitespace normalization on the
emitted source, `WN8`/`WN9` in `packages/core/tests/output-normalize.test.ts`
for the normalizer itself, and `TF6`/`TF7` in
`packages/core/tests/output-terminal.test.ts` for terminal formatting.

<Test name="a bare Plan emits the exact approved source" timeout="120s">
<Execution host="run" target="packages/cli/tests/document-suites/plan/emits-plan.md" as="run">
<TestAgent>
<TestAgent.Scenario session="planner" src="./agents/whitespace-plan.md" />
</TestAgent>

<Answers>
<Answer value={{ decision: "Approve" }} />
</Answers>

<CollectOutput as="output" />

<AssertEquals actual={run.result.ok} expected={true} />
</Execution>

The trailing spaces and the four newlines arrived intact, which is what says the
approved bytes reached the document's output whole.

<AssertStringIncludes
  actual={output}
  expected={"This program writes a file when something runs it.   \n\n\n\n"}
/>

And nothing ran it: the file the program names is not here.

<Glob include={["planned.txt"]} as="written" />
<AssertEquals actual={written.length} expected={0} />
</Test>

## The captured form binds those same bytes and emits nothing

`as` is ordinary text capture. The two forms differ only in where the source
goes, so the bytes a document binds are the bytes the bare form emits.

<Test name="a captured Plan binds the same bytes and emits no source" timeout="120s">
<Execution host="run" target="packages/cli/tests/document-suites/plan/captures-plan.md" as="run">
<TestAgent>
<TestAgent.Scenario session="planner" src="./agents/whitespace-plan.md" />
</TestAgent>

<Answers>
<Answer value={{ decision: "Approve" }} />
</Answers>

<CollectOutput as="output" />

<AssertEquals actual={run.result.ok} expected={true} />
</Execution>

The run printed no program: capture emits nothing.

<AssertEquals actual={output.includes("# Approved program")} expected={false} />

What it bound is in the file it wrote, byte for byte — the same whitespace the
bare form emitted, read back rather than presented.

<File path="captured.txt" as="captured" />
<AssertStringIncludes
  actual={captured}
  expected={"This program writes a file when something runs it.   \n\n\n\n"}
/>
<AssertStringIncludes actual={captured} expected="# Approved program" />

<File.Delete path="captured.txt" />

Still nothing ran it.

<Glob include={["planned.txt"]} as="alsoWritten" />
<AssertEquals actual={alsoWritten.length} expected={0} />
</Test>

## A tenth draft that cannot be repaired is explained, not reviewed

Ten drafts is the limit and the tenth cannot be revised, so a tenth draft that
still fails its check leaves no decision for a person to make. The workflow does
not ask for one. It asks the coding agent, once, why the attempts did not work,
and ends without a program.

The only answer this test supplies is **Request changes**. That is what makes
the ending evidence: if a tenth review had opened, it could not have offered
that decision, and the run would have failed on the answer rather than on the
explanation below.

<Test name="a tenth unrepairable draft is explained automatically" timeout="180s">
<Execution host="run" target="packages/cli/tests/document-suites/plan/uses-plan.md" as="run">
<TestAgent>
<TestAgent.Scenario session="planner" src="./agents/exhausted-plan.md" />
</TestAgent>

<Answers>
<Answer value={{ decision: "Request changes", feedback: "try again" }} />
</Answers>

<CollectOutput as="output" />

<AssertEquals actual={run.result.ok} expected={false} />

The ending says ten drafts were reviewed and carries the coding agent's own
explanation of why none of them worked.

<AssertStringIncludes
  actual={run.result.error.message}
  expected="reviewed ten drafts without an approved Plan"
/>
<AssertStringIncludes
  actual={run.result.error.message}
  expected="Every draft named a component this profile does not offer."
/>
</Execution>

No Plan came out of it, and the explanation was not mistaken for one.

<AssertEquals actual={output.includes("# A plan that cannot be checked")} expected={false} />
<Glob include={["planned.txt"]} as="none" />
<AssertEquals actual={none.length} expected={0} />
</Test>

## A draft with a revision left in it still reaches you

The automatic explanation is only for a tenth draft with nothing left to decide.
Everywhere else the review is unchanged: a draft that still has problems can be
sent back, and the draft that comes back can be approved.

The two answers below are told apart by what the review shows. A draft that
failed its check is presented with the problems that remain, so the matcher
naming that heading answers the first review; the second review has no such
heading and falls through to approval.

<Test name="requesting changes still produces a draft you can approve" timeout="120s">
<Execution host="run" target="packages/cli/tests/document-suites/plan/uses-plan.md" as="run">
<TestAgent>
<TestAgent.Scenario session="planner" src="./agents/revised-plan.md" />
</TestAgent>

<Answers>
<Answer
  template="{?before}Problems that remain{?after}"
  value={{ decision: "Request changes", feedback: "use a component that exists" }}
/>
<Answer value={{ decision: "Approve" }} />
</Answers>

<CollectOutput as="output" />

<AssertEquals actual={run.result.ok} expected={true} />

The revision was reviewed and approved, and its source is what came back.

<AssertStringIncludes actual={output} expected="# Approved program" />
<AssertEquals actual={output.includes("# A plan that cannot be checked")} expected={false} />
</Execution>

<Glob include={["planned.txt"]} as="written" />
<AssertEquals actual={written.length} expected={0} />
</Test>
