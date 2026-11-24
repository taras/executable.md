<Test name="a scripted Sidekick submits an entry and acknowledges its output" timeout="60s">
  <ReplBench scenario="examples/repl-bench/fixtures/repl-scripted-sidekick.md" expectExit={true} as="closed">
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
  <ReplBench scenario="examples/repl-bench/fixtures/repl-sidekick-ordered-reads.md" expectExit={true} as="closed">
    <ReplBench.SidekickPrompt text="What should I know?" as="exchange" />
    <AssertEquals actual={exchange.ending.joined} expected={true} />
    <AssertStringIncludes actual={exchange.output} expected="Read both." />
    <ReplBench.Key key="Ctrl+C" />
  </ReplBench>
  <AssertEquals actual={closed.exitCode} expected={0} />
</Test>

<Test name="History wheel and keyboard preserve a held Sidekick answer and reach its final outcome" timeout="120s">
  <ReplBench scenario="examples/repl-bench/fixtures/repl-sidekick-held-history.md" columns={120} rows={30}>
    <Each in={[0,1,2,3,4,5,6,7,8,9,10,11]} let="index">
      <Repl.Focus.Draft />
      <ReplBench.Key key="Enter" />
      <Let as="source" value={index===11 ? Array.from({length:70},(_,row)=>"Bg row "+row).join("\n") : '<Let as="history'+index+'" value={'+index+'} />'} />
      <ReplBench.Type text={source} />
      <ReplBench.WaitForText text={index===11 ? "Bg row 69" : "value={"+index+"}"} />
      <ReplBench.Key key="Tab" />
      <ReplBench.WaitForText text="> Send" />
      <ReplBench.Key key="Enter" />
      <ReplBench.WaitForText text={"Ready for Entry "+(index+2)} />
    </Each>

    <ReplBench.Focus target="sidekick-composer" />
    <ReplBench.Type text="question" />
    <ReplBench.Region name="sidekick-composer">
      <ReplBench.WaitForText text="question" />
    </ReplBench.Region>
    <ReplBench.Key key="Enter" />
    <Repl.Sidekick.OpenAnswer />
    <ReplBench.Type text="held-value" />
    <ReplBench.WaitForText text="held-value" />
    <ReplBench.Key key="ArrowLeft" />
    <ReplBench.WaitForText text="Bg row 0" as="background" />
    <ReplBench.Scroll delta={1} at={background} />
    <ReplBench.Key key="Tab" />
    <ReplBench.WaitForText text="> [submit]" />
    <ReplBench.WaitForText text="Bg row 0" at={background} />
    <ReplBench.WaitForText text="held-value" />
    <ReplBench.Key key="Shift+Tab" />
    <ReplBench.WaitForText text="[History]" as="history" />
    <ReplBench.Click at={history} />
    <ReplBench.WaitForText text="[Positions]" as="positions" />
    <ReplBench.Click at={positions} />
    <ReplBench.WaitForText text="[submit]" present={false} />
    <ReplBench.Region name="history">
      <ReplBench.Key key="Tab" />
      <ReplBench.WaitForText text="Enter closes" />
      <ReplBench.WaitForText text="24 · Entry outcome recorded" as="marker" />
      <ReplBench.Scroll delta={1} at={marker} />
      <ReplBench.WaitForText text="24 · Entry outcome recorded" present={false} />
      <ReplBench.Scroll delta={-1} at={marker} />
      <ReplBench.WaitForText text="24 · Entry outcome recorded" at={marker} />
      <ReplBench.Scroll delta={25} at={marker} />
      <ReplBench.WaitForText text="1 · Entry 1 admitted" />
    </ReplBench.Region>
    <ReplBench.WaitForText text="[live]" present={false} />
    <ReplBench.Region name="history">
      <ReplBench.Scroll delta={-25} at={marker} />
      <ReplBench.WaitForText text="24 · Entry outcome recorded" at={marker} />
    </ReplBench.Region>
    <ReplBench.Key key="Escape" />
    <ReplBench.WaitForText text="[submit]" />
    <ReplBench.WaitForText text="held-value" />
    <ReplBench.WaitForText text="> [History]" />

    <ReplBench.Click at={history} />
    <ReplBench.WaitForText text="[Positions]" as="positions" />
    <ReplBench.Click at={positions} />
    <ReplBench.WaitForText text="[submit]" present={false} />
    <ReplBench.WaitForText text="> 24 · Entry outcome recorded" />
    <Each in={[23,22,21,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1]} let="row">
      <ReplBench.Key key="ArrowDown" />
      <ReplBench.WaitForText text={"> "+row+" · Entry "+(row%2===0?"outcome recorded":((row+1)/2)+" admitted")} />
    </Each>
    <ReplBench.WaitForText text="[live]" present={false} />
    <ReplBench.Key key="ArrowUp" />
    <ReplBench.WaitForText text="> 2 · Entry outcome recorded" />
    <ReplBench.Key key="Enter" />
    <ReplBench.WaitForText text="[live]" />
    <ReplBench.SidekickStatus as="sidekick" />
    <AssertEquals actual={sidekick.messages.length} expected={2} />
    <AssertEquals actual={sidekick.canonical[0].attempted.length} expected={1} />
    <AssertEquals actual={sidekick.questionPending} expected={true} />
  </ReplBench>
</Test>
