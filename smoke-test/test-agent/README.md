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
</TestAgent>
