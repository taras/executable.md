<Test name="a saved Sidekick answer stays readable and ordinary Message continues after Stop" timeout="120s">
  <ReplBench scenario="scripts/tests/fixtures/repl-sidekick-stopped-answer.md" columns={160} rows={36} waitTimeout="30s" expectExit={true} as="closed">
    <ReplBench.Focus target="sidekick-composer" />
    <ReplBench.Type text="Ask me to save a decision." />
    <ReplBench.WaitForText text="Ask me to save a decision." />
    <ReplBench.Key key="Enter" />
    <ReplBench.WaitForText text="[answer sidekick]" as="answer" />
    <ReplBench.Click at={answer} />
    <ReplBench.Type text="keep-answer" />
    <ReplBench.WaitForText text="= keep-answer" />
    <ReplBench.Key key="Enter" />
    <ReplBench.WaitForText text="[answer sidekick]" present={false} />
    <ReplBench.WaitForText text="Automatic feed… · generating" />
    <ReplBench.Focus target="sidekick-composer" />
    <ReplBench.Key key="Alt+ArrowUp" />
    <ReplBench.WaitForText text="[send]" bold={true} />
    <ReplBench.Key key="Alt+ArrowUp" />
    <ReplBench.WaitForText text="[stop]" bold={true} />
    <ReplBench.Key key="Enter" />
    <ReplBench.WaitForText text="[stop]" present={false} />
    <ReplBench.WaitForText text="Answer saved. Feedback receipt unknown." timeout="10s" />
    <ReplBench.SidekickStatus as="before" />
    <ReplBench.Resize columns={72} rows={20} />
    <ReplBench.WaitForText text="Answer saved. Feedback receipt unknown." />
    <ReplBench.WaitForText text="Retained chat row 01." present={false} />
    <ReplBench.Focus target="sidekick-composer" />
    <ReplBench.Type text="RECOVERY-1269-FRES" />
    <ReplBench.Type text="H" />
    <ReplBench.Region name="sidekick-composer">
      <ReplBench.WaitForText text="RECOVERY-1269-FRESH" />
    </ReplBench.Region>
    <ReplBench.Key key="Enter" />
    <ReplBench.WaitForText text="Fresh instruction reached the same chat." />
    <ReplBench.WaitForText text="Answer saved. Feedback receipt unknown." />
    <ReplBench.WaitForText text="[stop]" present={false} />
    <ReplBench.SidekickStatus as="after" />
    <AssertEquals actual={after.conversation} expected={before.conversation} />
    <AssertEquals actual={after.messages.length} expected={before.messages.length + 1} />
    <AssertEquals actual={after.canonical[0].completed.length} expected={before.canonical[0].completed.length + 1} />
    <AssertEquals actual={after.canonical[0].attempted.length} expected={before.canonical[0].attempted.length + 1} />
    <AssertEquals actual={after.entries} expected={before.entries} />
    <AssertEquals actual={after.questionPending} expected={false} />
    <ReplBench.Focus target="sidekick-composer" />
    <ReplBench.Key key="Ctrl+C" />
  </ReplBench>
  <AssertEquals actual={closed.exitCode} expected={0} />
</Test>
