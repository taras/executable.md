<Test name="sequential REPL launches use the nearest Terminal viewport" timeout="120s">
  <Terminal columns={120} rows={30}>
    <ReplBench expectExit={true} as="closed">
      <Terminal.WaitForText text="Ready for Entry 1" />
      <Terminal.Type text="retained-marker-1272" />
      <Terminal.WaitForText text="retained-marker-1272" />
      <Terminal.Key key="Enter" />
      <Terminal.WaitForText text="Ready for Entry 2" />
      <ReplBench.Focus target="sidekick-composer" />
      <Terminal.Resize columns={72} rows={20} />
      <Terminal.WaitForText text="Entries    * Sidekick" />
      <Terminal.WaitForText text="[configure codex]" row={2} />
      <Try>
        <ReplBench><Terminal.WaitForText text="Ready for Entry 1" /></ReplBench>
        <Fail message="The overlapping bench started" />
        <Catch as="overlap"><AssertStringIncludes actual={overlap.message} expected="already has an active" /></Catch>
      </Try>

      <Terminal columns={160} rows={36}>
        <ReplBench>
          <Terminal.WaitForText text="TRANSCRIPT" row={1} />
          <Terminal.WaitForText text="Ready for Entry 1" />
          <Terminal.WaitForText text="retained-marker-1272" present={false} />
        </ReplBench>
      </Terminal>

      <Terminal.WaitForText text="Entries    * Sidekick" />
      <Terminal.Key key="Ctrl+C" />
    </ReplBench>
    <AssertEquals actual={closed.exitCode} expected={0} />
    <Try>
      <Terminal.WaitForText text="Entries    * Sidekick" />
      <Fail message="The exited bench answered a screen wait" />
      <Catch as="idle"><AssertStringIncludes actual={idle.message} expected="needs an active" /></Catch>
    </Try>

    <ReplBench resume={closed.resume} expectExit={true} as="reopened">
      <Terminal.WaitForText text="Entries    * Sidekick" />
      <Terminal.WaitForText text="message the sidekick" />
      <Terminal.WaitForText text="Entries" row={1} as="entriesTab" />
      <Terminal.Click at={entriesTab} />
      <Terminal.WaitForText text="1. [ok]" as="retainedEntry" />
      <Terminal.Click at={retainedEntry} />
      <Terminal.WaitForText text="retained-marker-1272" />
      <Terminal.WaitForText text="Ready for Entry 2" />
      <Terminal.WaitForText text="[exit]" as="exit" />
      <Terminal.Click at={exit} />
    </ReplBench>
    <AssertEquals actual={reopened.exitCode} expected={0} />

    <ReplBench>
      <Terminal.WaitForText text="Sidekick" row={1} />
      <Terminal.WaitForText text="TRANSCRIPT" row={1} present={false} />
      <Terminal.WaitForText text="HEAD · EMPTY" />
      <Terminal.WaitForText text="Ready for Entry 1" />
      <Terminal.WaitForText text="retained-marker-1272" present={false} />
    </ReplBench>
    <Terminal.Resize columns={120} rows={30} />
    <ReplBench resume={reopened.resume}>
      <Terminal.WaitForText text="TRANSCRIPT" row={1} />
      <Terminal.WaitForText text="retained-marker-1272" />
    </ReplBench>
  </Terminal>
</Test>
