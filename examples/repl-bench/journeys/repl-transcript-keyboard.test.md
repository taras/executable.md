<Test name="Transcript keyboard reaches every presented turn" timeout="90s">
  <ReplBench scenario="examples/repl-bench/fixtures/repl-sidekick-transcript.md" columns={160} rows={30} waitTimeout="30s">
    <ReplBench.Focus target="sidekick-composer" />
    <Each in={["00","01","02","03","04","05","06","07","08","09","10","11","12"]} let="turn">
      <ReplBench.Type text={"turn-"+turn} />
      <ReplBench.Region name="sidekick-composer">
        <ReplBench.WaitForText text={"turn-"+turn} />
      </ReplBench.Region>
      <ReplBench.Key key="Enter" />
      <ReplBench.WaitForText text={"Reply witness "+turn+"."} />
      <ReplBench.WaitForText text="[stop]" present={false} />
    </Each>

    <ReplBench.Type text="message-kept" />
    <ReplBench.WaitForText text="message-kept" as="message" />
    <ReplBench.Region name="transcript">
      <ReplBench.WaitForText text="turn-12" present={false} />
    </ReplBench.Region>
    <ReplBench.Key key="Tab" />
    <ReplBench.WaitForText text="> [History]" />
    <ReplBench.Key key="Tab" />
    <ReplBench.WaitForText text="> All sessions" />
    <ReplBench.Key key="Alt+ArrowDown" />
    <ReplBench.WaitForText text="> [U] Initialize this" />
    <ReplBench.Key key="ArrowDown" />
    <ReplBench.WaitForText text="> [U] turn-00" />
    <Each in={["01","02","03","04","05","06","07","08","09","10","11","12"]} let="turn">
      <ReplBench.Key key="ArrowDown" />
      <ReplBench.WaitForText text={"> [U] turn-"+turn} />
    </Each>
    <ReplBench.Region name="sidekick-composer">
      <ReplBench.WaitForText text="message-kept" at={message} />
    </ReplBench.Region>
    <ReplBench.WaitForText text="[Back to current chat]" present={false} />
    <ReplBench.SidekickStatus as="sidekick" />
    <AssertEquals actual={sidekick.messages.length} expected={14} />
    <AssertEquals actual={sidekick.canonical[0].attempted.length} expected={14} />
    <AssertEquals actual={sidekick.canonical[0].completed.length} expected={14} />
  </ReplBench>
</Test>
