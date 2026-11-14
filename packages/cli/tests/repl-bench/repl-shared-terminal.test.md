<Test name="sequential REPL launches use the nearest Terminal viewport" timeout="120s">
  <Terminal columns={120} rows={30}>
    <XMD.Repl expectExit={true} as="closed">
      <Terminal.WaitForText text="Ready for Entry 1" />
      <Terminal.Key key="Ctrl+G" />
      <Terminal.Key key="4" />
      <Terminal.Type text="retained-marker-1272" />
      <Terminal.WaitForText text="retained-marker-1272" />
      <Terminal.Key key="Enter" />
      <Terminal.WaitForText text="Ready for Entry 2" />
      <Terminal.Focus target="sidekick-composer" />
      <Terminal.Resize columns={72} rows={20} />
      <Terminal.WaitForText text="Entries    * Sidekick" />
      <Try>
        <XMD.Repl><Terminal.WaitForText text="Ready for Entry 1" /></XMD.Repl>
        <Fail message="The overlapping bench started" />
        <Catch as="overlap"><AssertStringIncludes actual={overlap.message} expected="already has an active" /></Catch>
      </Try>

      <Terminal columns={160} rows={36}>
        <XMD.Repl>
          <Terminal.WaitForText text="TRANSCRIPT" row={1} />
          <Terminal.WaitForText text="Ready for Entry 1" />
          <Terminal.WaitForText text="retained-marker-1272" present={false} />
        </XMD.Repl>
      </Terminal>

      <Terminal.WaitForText text="Entries    * Sidekick" />
      <Terminal.Key key="Ctrl+C" />
    </XMD.Repl>
    <AssertEquals actual={closed.exitCode} expected={0} />
    <Try>
      <Terminal.WaitForText text="Entries    * Sidekick" />
      <Fail message="The exited bench answered a screen wait" />
      <Catch as="idle"><AssertStringIncludes actual={idle.message} expected="needs an active" /></Catch>
    </Try>

    <XMD.Repl resume={closed.resume} expectExit={true} as="reopened">
      <Terminal.WaitForText text="Entries    * Sidekick" />
      <Terminal.WaitForText text="message the sidekick" />
      <Terminal.WaitForText text="Entries" row={1} as="entriesTab" />
      <Terminal.Click at={entriesTab} />
      <Terminal.WaitForText text="1. [ok]" as="retainedEntry" />
      <Terminal.Click at={retainedEntry} />
      <Terminal.WaitForText text="retained-marker-1272" />
      <Terminal.WaitForText text="Ready for Entry 2" />
      <Terminal.Focus target="sidekick-composer" />
      <Terminal.Key key="Ctrl+C" />
    </XMD.Repl>
    <AssertEquals actual={reopened.exitCode} expected={0} />

    <XMD.Repl>
      <Terminal.WaitForText text="Sidekick" row={1} />
      <Terminal.WaitForText text="TRANSCRIPT" row={1} present={false} />
      <Terminal.WaitForText text="HEAD · EMPTY" />
      <Terminal.WaitForText text="Ready for Entry 1" />
      <Terminal.WaitForText text="retained-marker-1272" present={false} />
    </XMD.Repl>
    <Terminal.Resize columns={120} rows={30} />
    <XMD.Repl resume={reopened.resume}>
      <Terminal.WaitForText text="TRANSCRIPT" row={1} />
      <Terminal.WaitForText text="retained-marker-1272" />
    </XMD.Repl>
  </Terminal>
</Test>

<Test name="build selection is lexical and a wrong revision refuses the launch" timeout="45s">
  <Terminal columns={72} rows={20}>
    <Dir path="packages">
      <Try>
        <XMD.Build checkout=".." expectedRevision="0000000000000000000000000000000000000000">
          <XMD.Repl><Fail message="The incorrectly pinned bench started" /></XMD.Repl>
        </XMD.Build>
        <Catch as="refusal">
          <AssertStringIncludes actual={refusal.message} expected="needs a clean worktree at 0000000000000000000000000000000000000000" />
        </Catch>
      </Try>
      <XMD.Build checkout="..">
        <XMD.Repl>
          <XMD.Repl.Revision as="observed" />
          <AssertEquals actual={typeof observed} expected="string" />
        </XMD.Repl>
      </XMD.Build>
      <XMD.Repl>
        <XMD.Repl.Revision as="ambient" />
        <AssertEquals actual={ambient} expected={null} />
      </XMD.Repl>
    </Dir>
  </Terminal>
</Test>
