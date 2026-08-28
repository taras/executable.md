# Test-agent smoke

One complete availability/session/prompt/text/teardown path through the
real ACPX runtime and a real `xmd test-agent` worker.

<TestAgent>
  <TestAgent.Scenario
    agent="test"
    session="review"
    src="./agents/review.md"
  />

  <Test name="reviews a change" timeout="120s">
    <Agent name="test">
      <Session name="review">
        <Prompt text="Review packages/core at revision abc123" as="firstReply" />
        <Prompt text="Summarize packages/core" as="secondReply" />
      </Session>
    </Agent>
    <AssertStringIncludes actual={firstReply} expected="The review of **packages/core** at `abc123` passed." />
    <AssertStringIncludes actual={secondReply} expected="The review of **packages/core** passed." />
  </Test>

  `<TestAgent>` has a second placement. Written as a declaration inside an
  `<Execution host="run">` it scripts the agent a *child* document reaches, and
  `<Answers>` says what the child's elicitations are answered with. The child
  below is written the way an ordinary document is — it asks an agent to review
  a change, then asks a person whether to accept the answer — and nothing in it
  knows it is under test. The declarations are what make it deterministic.

  The child is written here rather than referenced, because a target resolves
  from the working directory and this document is run from several.

  <Test name="runs a nested document deterministically" timeout="120s">
    <Execution
      host="run"
      as="run"
      source={`
The review is one conversation, so it is sent inside a named session.

<Session name="review">
<Prompt text="Review packages/core at revision abc123" as="review" />
</Session>

{review}

Now the decision, which only a person can make.

<Elicit schema='{"type":"object","properties":{"decision":{"type":"string"}},"required":["decision"],"additionalProperties":false}' as="verdict">Approve the review?</Elicit>

You chose to {verdict.decision} the review.
`}
    >
      <TestAgent>
        <TestAgent.Scenario session="review" src="./agents/review.md" />
      </TestAgent>

      <Answers>
        <Answer template="Approve the review?" value={{ decision: "approve" }} />
      </Answers>

      <CollectOutput as="nested" />

      <AssertEquals actual={run.result.ok} expected={true} />
      <AssertStringIncludes actual={nested} expected="The review of **packages/core** at `abc123` passed." />
      <AssertStringIncludes actual={nested} expected="You chose to approve the review." />
    </Execution>

  A bound execution keeps its assertion body to itself, so what the child
  produced is shown here, where the person running this can read it:

  {run.result.value}
  </Test>
</TestAgent>
