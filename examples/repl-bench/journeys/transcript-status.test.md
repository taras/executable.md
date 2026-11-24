<Cwd as="checkout" />
<Let as="fixtureRoot" value={checkout + "/examples/repl-bench/fixtures"} />

<Test name="#971 settled, running, failed and interrupted work remains distinguishable" timeout="45s">
  <Terminal columns={160} rows={36}>
    <XMD.Repl>
      <Repl.Focus.Draft />
      <Terminal.Key key="Enter" />
      <Terminal.Type text={"<Output>Checkout output witness</Output>"} />
      <Terminal.Key key="Tab" />
      <Terminal.WaitForText text="> Send" />
      <Terminal.Key key="Enter" />
      <Terminal.WaitForText text="Checkout output witness" />
      <Terminal.WaitForText text="1 ✓" />
      <Terminal.Region name="transcript">
        <Terminal.WaitForText text="· completed" present={false} />
      </Terminal.Region>
      <Terminal.Screenshot name="settled-without-completed-label" />

      <Repl.Focus.Draft />
      <Terminal.Key key="Enter" />
      <Terminal.Type text={'<Fail message="Checkout fixture failed" />'} />
      <Terminal.Key key="Tab" />
      <Terminal.WaitForText text="> Send" />
      <Terminal.Key key="Enter" />
      <Terminal.WaitForText text="Checkout fixture failed" />
      <Terminal.WaitForText text="2 ×" />

      <Repl.Focus.Draft />
      <Terminal.Key key="Enter" />
      <Terminal.Type text={"\x60\x60\x60sh exec\nprintf '%s\\n' 'Held checkout'\nsleep 25\n\x60\x60\x60"} />
      <Terminal.Key key="Tab" />
      <Terminal.WaitForText text="> Send" />
      <Terminal.Key key="Enter" />
      <Terminal.WaitForText text="Held checkout" />
      <Terminal.WaitForText text="3 ⠋" />
      <Terminal.WaitForText text="[History]" row={35} />
      <Terminal.WaitForText text="Tab regions" present={false} />
      <Terminal.Screenshot name="running" />
      <Terminal.WaitForText text="Stop" as="stop" />
      <Terminal.Click at={stop} />
      <Terminal.WaitForText text="INTERRUPTED" />
      <Terminal.Screenshot name="interrupted" />
    </XMD.Repl>
  </Terminal>
</Test>

<Test name="#971 a Sidekick preview starts with content and a dismissed error remains in the conversation" timeout="45s">
  <Terminal columns={160} rows={36}>
    <XMD.Repl scenario={fixtureRoot + "/repl-ui-status.md"}>
      <XMD.Repl.SidekickPrompt text="Show the formatting fixture." as="turn" />
      <AssertStringIncludes actual={turn.output} expected="Reading cart.md." />
      <Terminal.Region name="transcript">
        <Terminal.WaitForText text="[S] Reading cart.md." />
        <Terminal.WaitForText text="· completed" present={false} />
      </Terminal.Region>
      <Terminal.WaitForText text="items.reduce" as="indented" />
      <Terminal.WaitForText text="[S] Reading cart.md." row={indented.row - 2} />
      <Terminal.Screenshot name="trimmed-output" />

      <Repl.Focus.Message />
      <Terminal.Type text="Trigger the scripted prompt mismatch." />
      <Terminal.Key key="Enter" />
      <Terminal.WaitForText text="Sidekick reply failed" as="notification" />
      <AssertEquals actual={notification.row < 8} expected={true} />
      <AssertEquals actual={notification.column > 100} expected={true} />
      <Terminal.Screenshot name="failure-notification" />
      <Terminal.Resize columns={72} rows={20} />
      <Repl.Focus.Message />
      <Terminal.WaitForText text="Sidekick reply failed" as="narrow" />
      <AssertEquals actual={narrow.row < 5 && narrow.column < 10} expected={true} />
      <Terminal.WaitForText text="[History]" row={19} />
      <Terminal.Screenshot name="failure-notification-narrow" />
      <Terminal.Key key="Escape" />
      <Terminal.WaitForText text="Sidekick reply failed" present={false} />
      <Terminal.WaitForText text="dismissed" />
      <Terminal.Screenshot name="failure-dismissed-narrow" />
      <Terminal.Resize columns={160} rows={36} />
      <Terminal.WaitForText text="Sidekick reply failed" present={false} />
      <Terminal.WaitForText text="dismissed" />
      <Terminal.Screenshot name="failure-dismissed" />
    </XMD.Repl>
  </Terminal>
</Test>
