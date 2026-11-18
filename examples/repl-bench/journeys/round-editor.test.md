<Test name="New Round opens the editor and sends only from the round bar" timeout="60s">
  <Cwd as="checkout" />
  <XMD.Build checkout={checkout}>
    <Each in={[{columns: 160, rows: 36}, {columns: 120, rows: 30}, {columns: 72, rows: 20}]} let="viewport">
      <Terminal columns={viewport.columns} rows={viewport.rows}>
        <XMD.Repl expectExit={true} as="closed">
          <Terminal.Type text="unsent message witness" />
          <Terminal.WaitForText text="unsent message witness" />
          <Terminal.WaitForText text="+ New Round" as="open" />
          <If condition={viewport.columns === 72}>
            <Terminal.Key key="Ctrl+G" />
            <Terminal.Key key="4" />
            <Terminal.Key key="Enter" />
            <Else>
              <Terminal.Click at={open} />
            </Else>
          </If>
          <Terminal.WaitForText text="Round 1 · draft" />
          <Terminal.Screenshot name="draft-open" />
          <Terminal.Key key="Tab" />
          <Terminal.WaitForText text="> Send" />
          <Terminal.Key key="Enter" />
          <Terminal.WaitForText text="Round 1 · draft" />
          <Terminal.Key key="Shift+Tab" />
          <Terminal.Type text="First witness." />
          <Terminal.Key key="Enter" />
          <Terminal.Type text="Second witness." />
          <Terminal.WaitForText text="First witness." as="first" />
          <Terminal.WaitForText text="Second witness." row={first.row + 1} />
          <Terminal.Key key="End" />
          <Terminal.Type text={"\n\n\x60\x60\x60sh exec\nsleep 2.5\n\x60\x60\x60"} />
          <Terminal.Key key="Tab" />
          <Terminal.WaitForText text="> Send" as="send" />
          <Terminal.Screenshot name="send-focused" />
          <If condition={viewport.columns === 120}>
            <Terminal.Click at={send} />
            <Else>
              <Terminal.Key key="Enter" />
            </Else>
          </If>
          <Terminal.WaitForText text="● running · user" />
          <Terminal.WaitForText text="1 ⠋" />
          <Terminal.Screenshot name="running" />
          <If condition={viewport.columns === 72}>
            <Repl.Focus.Transcript />
          </If>
          <Terminal.Region name="transcript">
            <Terminal.WaitForText text="── Round 1 ──" />
            <Terminal.Screenshot name="running-transcript" />
          </Terminal.Region>
          <If condition={viewport.columns === 120}>
            <Terminal.WaitForText text="Stop" as="stop" />
            <Terminal.Click at={stop} />
            <Terminal.WaitForText text="1 -" />
            <Else>
              <Terminal.WaitForText text="1 ✓" />
            </Else>
          </If>
          <Repl.Focus.Message />
          <Terminal.WaitForText text="unsent message witness" />
          <Terminal.Key key="Ctrl+C" />
          <Terminal.Key key="Ctrl+C" />
        </XMD.Repl>
        <AssertEquals actual={closed.exitCode} expected={0} />
        <Output><Json value={{viewport, closed}} /></Output>
      </Terminal>
    </Each>
  </XMD.Build>
</Test>
