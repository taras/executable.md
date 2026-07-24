# Test-agent smoke

One complete availability/session/prompt/text/teardown path through the
real ACPX runtime and a real `xmd test-agent` worker.

<TestAgent>
  <TestAgent.Scenario
    agent="test"
    session="review"
    src="./agents/review.md"
  />

  <Test name="reviews a change">
    <Agent name="test">
      <Session name="review">
        <Prompt prompt="Review packages/core at revision abc123" as="firstReply" />
        <Prompt prompt="Summarize packages/core" as="secondReply" />
      </Session>
    </Agent>
    <AssertStringIncludes actual={firstReply} expected="The review of **packages/core** at `abc123` passed." />
    <AssertStringIncludes actual={secondReply} expected="The review of **packages/core** passed." />
  </Test>
</TestAgent>
