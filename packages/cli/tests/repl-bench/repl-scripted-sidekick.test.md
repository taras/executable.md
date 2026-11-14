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

<Test name="Transcript wheel and keyboard reach the exact presented turn" timeout="90s">
  <ReplBench scenario="scripts/tests/fixtures/repl-sidekick-transcript.md" columns={160} rows={36}>
    <ReplBench.Focus target="sidekick-composer" />
    <Each in={["00","01","02","03","04","05","06","07","08","09","10","11","12","13","14","15","16","17"]} let="turn">
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
      <ReplBench.WaitForText text="turn-00" as="first" />
      <ReplBench.WaitForText text="turn-01" as="second" />
      <ReplBench.Scroll delta={1} at={first} />
      <ReplBench.WaitForText text="turn-01" at={{row:second.row-3,column:second.column}} />
      <ReplBench.Region name="sidekick-composer">
        <ReplBench.WaitForText text="message-kept" at={message} />
      </ReplBench.Region>

      <ReplBench.Scroll delta={-1} at={first} />
      <ReplBench.WaitForText text="turn-00" at={first} />
      <ReplBench.WaitForText text="turn-01" at={second} />
      <ReplBench.Region name="sidekick-composer">
        <ReplBench.WaitForText text="message-kept" at={message} />
      </ReplBench.Region>

      <ReplBench.Scroll delta={30} at={first} />
      <ReplBench.WaitForText text="turn-17" />
      <ReplBench.Scroll delta={-30} at={first} />
      <ReplBench.WaitForText text="turn-00" at={first} />
    </ReplBench.Region>

    <ReplBench.Key key="Tab" />
    <ReplBench.WaitForText text="> [history]" />
    <ReplBench.Key key="Tab" />
    <ReplBench.WaitForText text="> All sessions" />
    <ReplBench.Key key="Alt+ArrowDown" />
    <ReplBench.WaitForText text="> [U] Initialize this" />
    <ReplBench.Key key="ArrowDown" />
    <ReplBench.WaitForText text="> [U] turn-00" />
    <Each in={["01","02","03","04","05","06","07","08","09","10","11","12","13","14","15","16","17"]} let="turn">
      <ReplBench.Key key="ArrowDown" />
      <ReplBench.WaitForText text={"> [U] turn-"+turn} />
    </Each>
    <ReplBench.Region name="sidekick-composer">
      <ReplBench.WaitForText text="message-kept" at={message} />
    </ReplBench.Region>
    <ReplBench.WaitForText text="[Back to current chat]" present={false} />
    <ReplBench.SidekickStatus as="sidekick" />
    <AssertEquals actual={sidekick.messages.length} expected={19} />
    <AssertEquals actual={sidekick.canonical[0].attempted.length} expected={19} />
    <AssertEquals actual={sidekick.canonical[0].completed.length} expected={19} />
  </ReplBench>
</Test>

<Test name="History wheel and keyboard preserve a held Sidekick answer and reach its final outcome" timeout="120s">
  <ReplBench scenario="scripts/tests/fixtures/repl-sidekick-held-history.md" columns={120} rows={30}>
    <Terminal.Key key="Ctrl+G" />
    <Terminal.Key key="4" />
    <Each in={[0,1,2,3,4,5,6,7,8,9,10,11]} let="index">
      <Let as="source" value={index===11 ? Array.from({length:70},(_,row)=>"Background row "+row).join("\n") : '<Let as="history'+index+'" value={'+index+'} />'} />
      <ReplBench.Type text={source} />
      <ReplBench.WaitForText text={index===11 ? "Background row 69" : "value={"+index+"}"} />
      <ReplBench.Key key="Enter" />
      <ReplBench.WaitForText text={"Ready for Entry "+(index+2)} />
    </Each>

    <ReplBench.Focus target="sidekick-composer" />
    <ReplBench.Type text="question" />
    <ReplBench.Region name="sidekick-composer">
      <ReplBench.WaitForText text="question" />
    </ReplBench.Region>
    <ReplBench.Key key="Enter" />
    <ReplBench.WaitForText text="[answer sidekick]" as="answer" />
    <ReplBench.Click at={answer} />
    <ReplBench.WaitForText text="[submit]" />
    <ReplBench.Type text="held-value" />
    <ReplBench.WaitForText text="= held-value" />
    <ReplBench.Key key="ArrowLeft" />
    <ReplBench.WaitForText text="Background row 0" as="background" />
    <ReplBench.Scroll delta={1} at={background} />
    <ReplBench.Key key="Tab" />
    <ReplBench.WaitForText text="> [submit]" />
    <ReplBench.WaitForText text="Background row 0" at={background} />
    <ReplBench.WaitForText text="= held-value" />
    <ReplBench.Key key="Shift+Tab" />
    <ReplBench.WaitForText text="[history]" as="history" />
    <ReplBench.Click at={history} />
    <ReplBench.WaitForText text="[submit]" present={false} />
    <ReplBench.Region name="history">
      <ReplBench.Key key="Tab" />
      <ReplBench.WaitForText text="1 · Entry 1 admitted" as="marker" />
      <ReplBench.Scroll delta={1} at={marker} />
      <ReplBench.WaitForText text="1 · Entry 1 admitted" present={false} />
      <ReplBench.Scroll delta={-1} at={marker} />
      <ReplBench.WaitForText text="1 · Entry 1 admitted" at={marker} />
      <ReplBench.Scroll delta={25} at={marker} />
      <ReplBench.WaitForText text="24 · Entry outcome recorded" />
    </ReplBench.Region>
    <ReplBench.WaitForText text="[live]" present={false} />
    <ReplBench.Region name="history">
      <ReplBench.Scroll delta={-25} at={marker} />
      <ReplBench.WaitForText text="1 · Entry 1 admitted" at={marker} />
    </ReplBench.Region>
    <ReplBench.Key key="Escape" />
    <ReplBench.WaitForText text="[submit]" />
    <ReplBench.WaitForText text="= held-value" />
    <ReplBench.Key key="Tab" />
    <ReplBench.Key key="Shift+Tab" />
    <ReplBench.Type text="X" />
    <ReplBench.WaitForText text="held-valuXe" />

    <ReplBench.Click at={history} />
    <ReplBench.WaitForText text="[submit]" present={false} />
    <ReplBench.WaitForText text="> 1 · Entry 1 admitted" />
    <Each in={[2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24]} let="row">
      <ReplBench.Key key="ArrowDown" />
      <ReplBench.WaitForText text={"> "+row+" · Entry "+(row%2===0?"outcome recorded":((row+1)/2)+" admitted")} />
    </Each>
    <ReplBench.WaitForText text="[live]" present={false} />
    <ReplBench.Key key="ArrowUp" />
    <ReplBench.WaitForText text="> 23 · Entry 12 admitted" />
    <ReplBench.Key key="Enter" />
    <ReplBench.WaitForText text="[live]" />
    <ReplBench.SidekickStatus as="sidekick" />
    <AssertEquals actual={sidekick.messages.length} expected={2} />
    <AssertEquals actual={sidekick.canonical[0].attempted.length} expected={1} />
    <AssertEquals actual={sidekick.questionPending} expected={true} />
  </ReplBench>
</Test>
