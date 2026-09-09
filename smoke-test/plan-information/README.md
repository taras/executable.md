# Plan information-request smoke

One complete read-only information request, through an embedded `<Plan>`, in
whichever installation runs this file.

The journey is the whole point. A coding agent answers the drafting turn with a
read-only XMD program, the `<Plan>` Component evaluates it under the ceiling that
installation ships, the findings come back as the next turn's context, and the
Plan that turn produces is reviewed and approved.

What makes it a distribution probe rather than a restatement of the unit
evidence: `<Syntax>` documentation is answered from packaged assets and the
protected tier, and the packaged `Plan.md` is Markdown rather than a module. A
build that lost any of the three still resolves every name here and then fails —
at a person's first `xmd plan`, or here.

The child is written here rather than referenced, because a target resolves from
the working directory and this document is run from several. Nothing in it knows
it is under test: it asks for a program and prints what it was given, which is
all an embedded `<Plan>` is.

The journey is mixed on purpose: the agent's first request asks for something the
read-only ceiling refuses, its second asks a question that is answered, and only
then does it write a Plan. Both halves of the loop therefore cross every
packaging boundary, not just the one that succeeds.

The proof that each exchange happened is in `agents/plan.md` rather than here.
Its second `<WhenPrompt>` answers only a prompt carrying the refusal, and its
third only a prompt carrying the selected documentation. So a build where a
request was never evaluated — or where its findings or its refusal never reached
the following turn — sends that agent something it will not answer, and no Plan
is ever written to assert about.

<Test name="a request is answered, then a Plan is approved" timeout="180s">
  <Execution
    host="run"
    as="planned"
    source={`
# A document that writes a Plan

<Plan session="planner" as="approved">Write the release program.</Plan>

Approved source: {approved}
`}
  >
    <TestAgent>
      <TestAgent.Scenario session="planner" src="./agents/plan.md" />
    </TestAgent>

    <Answers>
      <Answer value={{ decision: "Approve" }} />
    </Answers>

    <CollectOutput as="output" />

    <AssertEquals actual={planned.result.ok} expected={true} />
    <AssertStringIncludes actual={output} expected="# Approved program" />
    <AssertStringIncludes actual={output} expected="the approved Plan ran" />
  </Execution>

  The approved source, shown where the person running this can read it. It is
  text: this document renders a Plan and never runs one.

  {planned.result.value}
</Test>
