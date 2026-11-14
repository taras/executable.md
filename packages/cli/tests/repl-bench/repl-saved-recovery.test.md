<Test name="Saved recovery stays visible through resize without a new prompt" timeout="90s">
  <ReplBench scenario="scripts/tests/fixtures/repl-sidekick-saved-recovery.md" columns={160} rows={36} waitTimeout="30s" expectExit={true} as="closed">
    <Terminal.WaitForText text="SIDEKICK" row={1} as="sidekickTab" />
    <Terminal.Click at={sidekickTab} />
    <ReplBench.Type text="Inspect output." />
    <ReplBench.Key key="Enter" />
    <ReplBench.WaitForText text="Entry saved. Feedback receipt unknown." />
    <ReplBench.SidekickStatus as="before" />
    <ReplBench.EntryOutput entry={1} as="entryBefore" />
    <AssertEquals actual={entryBefore.status} expected="completed" />
    <AssertEquals actual={before.canonical[0].attempted.length} expected={3} />
    <AssertEquals actual={before.canonical[0].completed.length} expected={2} />
    <Each in={["OUTPUT-BEGIN: verified","ROW01: item verified","ROW02: item verified","ROW03: item verified","ROW04: item verified","ROW05: item verified","ROW06: item verified","ROW07: item verified","ROW08: item verified","OUTPUT-END: retained"]} let="line">
      <AssertStringIncludes actual={entryBefore.text} expected={line} />
    </Each>
    <ReplBench.Resize columns={120} rows={30} />
    <ReplBench.WaitForText text="Feedback receipt unknown." />
    <ReplBench.Resize columns={72} rows={20} />
    <ReplBench.WaitForText text="Entry saved. Feedback receipt unknown." />
    <ReplBench.SidekickStatus as="passive" />
    <ReplBench.EntryOutput entry={1} as="entryPassive" />
    <AssertEquals actual={passive.conversation} expected={before.conversation} />
    <AssertEquals actual={passive.messages} expected={before.messages} />
    <AssertEquals actual={passive.canonical} expected={before.canonical} />
    <AssertEquals actual={entryPassive} expected={entryBefore} />
    <ReplBench.Focus target="sidekick-composer" />
    <ReplBench.Type text="Summarize the verified inventory." />
    <ReplBench.Region name="sidekick-composer">
      <ReplBench.WaitForText text="inventory." />
    </ReplBench.Region>
    <ReplBench.SidekickStatus as="typed" />
    <AssertEquals actual={typed.messages} expected={before.messages} />
    <AssertEquals actual={typed.canonical} expected={before.canonical} />
    <ReplBench.Key key="Ctrl+C" />
    <ReplBench.Key key="Ctrl+C" />
  </ReplBench>
  <AssertEquals actual={closed.exitCode} expected={0} />
</Test>
