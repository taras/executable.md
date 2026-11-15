<Cwd as="checkout" />
<Let as="fixtureRoot" value={checkout + "/examples/repl-bench/fixtures"} />

<Test name="#1201 the usage toggle hides and restores usage without moving the conversation" timeout="45s">
  <Terminal columns={160} rows={36}>
    <XMD.Repl scenario={fixtureRoot + "/repl-ui-status.md"}>
      <XMD.Repl.SidekickPrompt text="Show the formatting fixture." as="turn" />
      <AssertStringIncludes actual={turn.output} expected="Reading cart.md." />
      <Repl.Focus.Message />
      <Terminal.Type text="unsent usage witness" />
      <Terminal.WaitForText text="> › message the sidekick" />
      <Terminal.WaitForText text="[ ] Show token usage" row={0} as="off" />
      <Terminal.WaitForText text="Sidekick total" present={false} />
      <Terminal.Screenshot name="usage-off" />
      <Terminal.Click at={off} />
      <Terminal.WaitForText text="[x] Show token usage" row={0} />
      <Terminal.WaitForText text="Usage unavailable" />
      <Terminal.WaitForText text="Sidekick total" />
      <Terminal.WaitForText text="Reading cart.md." />
      <Terminal.WaitForText text="> › message the sidekick" />
      <Terminal.Screenshot name="usage-on" />
      <Terminal.Resize columns={72} rows={20} />
      <Repl.Focus.Message />
      <Terminal.WaitForText text="[x] Show token usage" row={0} as="onNarrow" />
      <Terminal.WaitForText text="Sidekick total" />
      <Terminal.WaitForText text="Reading cart.md." />
      <Terminal.WaitForText text="> › message the sidekick" />
      <Terminal.Region name="sidekick-composer">
        <Terminal.WaitForText text="unsent usage witness" />
      </Terminal.Region>
      <Terminal.Screenshot name="usage-on-narrow" />
      <Terminal.Click at={onNarrow} />
      <Terminal.WaitForText text="[ ] Show token usage" row={0} />
      <Terminal.WaitForText text="> › message the sidekick" />
      <Terminal.WaitForText text="Usage unavailable" present={false} />
      <Terminal.WaitForText text="Sidekick total" present={false} />
      <Terminal.WaitForText text="Reading cart.md." />
    </XMD.Repl>
  </Terminal>
</Test>
