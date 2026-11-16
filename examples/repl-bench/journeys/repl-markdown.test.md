<Test name="written Markdown formats the chat and the entry Output and keeps the retained text" timeout="120s">
  <Terminal columns={160} rows={36}>
    <ReplBench scenario="examples/repl-bench/fixtures/repl-sidekick-markdown.md" expectExit={true} as="closed">
      <ReplBench.SidekickPrompt text="Show the Markdown fixture." as="exchange" />
      <AssertEquals actual={exchange.ending.joined} expected={true} />
      <AssertStringIncludes actual={exchange.output} expected="Markdown fixture receipt read." />
      <ReplBench.WaitForText text="HEAD · SETTLED" />

      <ReplBench.EntryOutput entry={1} as="entry" />
      <AssertEquals actual={entry.status} expected="completed" />
      <AssertStringIncludes actual={entry.text} expected="[entry fixture label](https://example.test/entry-target) plain" />
      <AssertStringIncludes actual={entry.text} expected="**entry strong** plain" />
      <AssertStringIncludes actual={entry.text} expected="```text" />

      <ReplBench.WaitForText text="Entry fixture heading" bold={true} />
      <ReplBench.WaitForText text="entry strong plain" bold={true} />
      <ReplBench.WaitForText text="entry fixture label plain" />
      <ReplBench.WaitForText text="  entry fence indent" />
      <ReplBench.WaitForText text="Entry fixture end." />

      <ReplBench.WaitForText text="[S] Markdown fixture receipt read." as="receipt" />
      <ReplBench.Scroll delta={-30} at={receipt} />
      <ReplBench.WaitForText text="Sidekick fixture heading" bold={true} />
      <ReplBench.WaitForText text="sidekick strong plain" bold={true} />
      <ReplBench.WaitForText text="sidekick fixture label plain" />
      <ReplBench.WaitForText text="• sidekick first item" />
      <ReplBench.WaitForText text="Sidekick fixture end." />

      <ReplBench.Resize columns={72} rows={20} />
      <ReplBench.WaitForText text="Sidekick" row={1} />
      <ReplBench.Key key="Ctrl+C" />
    </ReplBench>
    <AssertEquals actual={closed.exitCode} expected={0} />

    <ReplBench resume={closed.resume} expectExit={true} as="reopened">
      <ReplBench.WaitForText text="Entry fixture heading" bold={true} />
      <ReplBench.WaitForText text="entry strong plain" bold={true} />
      <ReplBench.Key key="Ctrl+C" />
    </ReplBench>
    <AssertEquals actual={reopened.exitCode} expected={0} />
  </Terminal>
</Test>
