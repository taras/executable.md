<Test name="a scripted Sidekick submits an entry and acknowledges its output" timeout="60s">
  <ReplBench scenario="scripts/tests/fixtures/repl-scripted-sidekick.md" expectExit={true} as="closed">
    <ReplBench.SidekickPrompt text="Run the fixture entry." as="exchange" />
    <AssertEquals actual={exchange.ending.joined} expected={true} />
    <AssertEquals actual={exchange.ending.outcome} expected="completed" />
    <AssertStringIncludes actual={exchange.output} expected="Scripted Sidekick received the entry result." />

    <ReplBench.EntryOutput entry={1} as="entry" />
    <AssertEquals actual={entry.status} expected="completed" />
    <AssertStringIncludes actual={entry.text} expected="Fixture entry ran." />
    <ReplBench.WaitForText text="HEAD · SETTLED" />
    <ReplBench.Key key="Ctrl+C" />
  </ReplBench>
  <AssertEquals actual={closed.exitCode} expected={0} />
</Test>

<Test name="Sidekick receives two reads in admission order" timeout="60s">
  <ReplBench scenario="scripts/tests/fixtures/repl-sidekick-ordered-reads.md" expectExit={true} as="closed">
    <ReplBench.SidekickPrompt text="What should I know?" as="exchange" />
    <AssertEquals actual={exchange.ending.joined} expected={true} />
    <AssertStringIncludes actual={exchange.output} expected="Read both." />
    <ReplBench.Key key="Ctrl+C" />
  </ReplBench>
  <AssertEquals actual={closed.exitCode} expected={0} />
</Test>
