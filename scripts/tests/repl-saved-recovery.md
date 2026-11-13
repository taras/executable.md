<Test name="Saved recovery is open before resize and reads retained feedback without a new prompt" timeout="90s">
  <ReplBench scenario="scripts/tests/fixtures/repl-sidekick-saved-recovery.md" columns={160} rows={36}>
    <ReplBench.WaitForText text="Original conversation:" present={false} />
    <ReplBench.Focus target="sidekick-composer" />
    <ReplBench.Type text="Inspect output." />
    <ReplBench.Key key="Enter" />
    <ReplBench.WaitForText text="[review recovery]" />
    <ReplBench.SidekickStatus as="before" />
    <ReplBench.EntryOutput entry={1} as="entryBefore" />
    <AssertEquals actual={entryBefore.status} expected="completed" />
    <AssertEquals actual={before.canonical[0].attempted.length} expected={3} />
    <AssertEquals actual={before.canonical[0].completed.length} expected={2} />
    <Each in={["OUTPUT-BEGIN: verified","ROW01: item verified","ROW02: item verified","ROW03: item verified","ROW04: item verified","ROW05: item verified","ROW06: item verified","ROW07: item verified","ROW08: item verified","OUTPUT-END: retained"]} let="line">
      <AssertStringIncludes actual={entryBefore.text} expected={line} />
    </Each>
    <ReplBench.Focus target="sidekick-composer" />
    <ReplBench.Key key="Alt+ArrowUp" />
    <ReplBench.WaitForText text="[send]" bold={true} />
    <ReplBench.Key key="Alt+ArrowUp" />
    <ReplBench.WaitForText text="[x] Follow" bold={true} />
    <ReplBench.Key key="Alt+ArrowUp" />
    <ReplBench.WaitForText text="[review recovery]" bold={true} />
    <ReplBench.Key key="Enter" />
    <ReplBench.WaitForText text="Original conversation:" />
    <ReplBench.Resize columns={120} rows={30} />
    <ReplBench.WaitForText text="Review recovery" />
    <ReplBench.Region name="recovery">
      <ReplBench.WaitForText text="Original conversation:" />
      <ReplBench.Scroll delta={2} />
      <ReplBench.WaitForText text="OUTPUT-BEGIN:" />
      <ReplBench.WaitForText text="ROW01:" />
      <ReplBench.WaitForText text="ROW02:" />
      <ReplBench.WaitForText text="ROW03:" />
      <ReplBench.Scroll delta={3} />
      <ReplBench.WaitForText text="ROW04:" />
      <ReplBench.WaitForText text="ROW05:" />
      <ReplBench.WaitForText text="ROW06:" />
      <ReplBench.WaitForText text="ROW07:" />
      <ReplBench.WaitForText text="ROW08:" />
      <ReplBench.WaitForText text="OUTPUT-END:" />
      <ReplBench.Scroll delta={30} />
      <ReplBench.WaitForText text="New instruction:" />
      <ReplBench.Key key="Shift+Tab" />
      <ReplBench.WaitForText text=">> New instruction:" />
    </ReplBench.Region>
    <ReplBench.Key key="Escape" />
    <ReplBench.WaitForText text="Review recovery" present={false} />
    <ReplBench.Resize columns={160} rows={36} />
    <ReplBench.WaitForText text="[review recovery]" bold={true} />
    <ReplBench.Key key="Enter" />
    <ReplBench.WaitForText text="Review recovery" />
    <ReplBench.SidekickStatus as="passive" />
    <ReplBench.EntryOutput entry={1} as="entryPassive" />
    <AssertEquals actual={passive.conversation} expected={before.conversation} />
    <AssertEquals actual={passive.messages} expected={before.messages} />
    <AssertEquals actual={passive.canonical} expected={before.canonical} />
    <AssertEquals actual={entryPassive} expected={entryBefore} />
    <ReplBench.Region name="recovery">
      <ReplBench.WaitForText text=">> New instruction:" />
      <ReplBench.Key key="End" />
      <ReplBench.Type text="Summarize the verified inventory." />
      <ReplBench.WaitForText text="inventory." />
      <ReplBench.SidekickStatus as="typed" />
      <AssertEquals actual={typed.messages} expected={before.messages} />
      <AssertEquals actual={typed.canonical} expected={before.canonical} />
    </ReplBench.Region>
  </ReplBench>
</Test>
