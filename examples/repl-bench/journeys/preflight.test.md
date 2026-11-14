<Test name="the bench opens, clears the composer, and returns a reopen link at both sizes">
  <Cwd as="checkout" />
  <XMD.Build checkout={checkout}>
    <Each in={[{columns: 160, rows: 36}, {columns: 72, rows: 20}]} let="viewport">
      <Terminal columns={viewport.columns} rows={viewport.rows}>
        <XMD.Repl expectExit={true} as="closed">
          <Terminal.Focus target="sidekick-composer" />
          <Terminal.Type text="repl-bench check;" />
          <Terminal.Region name="sidekick-composer">
            <Terminal.WaitForText text="repl-bench check;" />
            <Terminal.Key key="Ctrl+C" />
            <Terminal.WaitForText text="repl-bench check;" present={false} />
          </Terminal.Region>
          <Terminal.Key key="Ctrl+C" />
        </XMD.Repl>
        <AssertEquals actual={closed.exitCode} expected={0} />
        <AssertMatch actual={closed.location} expected={/^xmd:\/\/repl\/.*[?&]view=sidekick/} />
        <Output><Json value={{viewport, exitCode: closed.exitCode, location: closed.location}} /></Output>
      </Terminal>
    </Each>
  </XMD.Build>
</Test>
