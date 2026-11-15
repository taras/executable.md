<Cwd as="checkout" />
<Let as="fixtureRoot" value={checkout + "/examples/repl-bench/fixtures"} />

<Test name="#971 layout keeps Sidekick visible at each supported width" timeout="40s">
  <Terminal columns={160} rows={36}>
    <XMD.Repl>
      <Terminal.WaitForText text="TRANSCRIPT" row={1} />
      <Terminal.WaitForText text="Entries" row={1} />
      <Terminal.WaitForText text="SIDEKICK" row={1} as="sidekickWide" />
      <Terminal.WaitForText text="BINDINGS" row={1} as="bindingsWide" />
      <AssertEquals actual={sidekickWide.column < bindingsWide.column} expected={true} />
      <Terminal.WaitForText text="HISTORY" row={34} />
      <Terminal.Screenshot name="layout-wide" />
      <Terminal.Resize columns={120} rows={30} />
      <Terminal.WaitForText text="TRANSCRIPT" row={1} />
      <Terminal.WaitForText text="SIDEKICK" row={1} />
      <Terminal.WaitForText text="HISTORY" row={28} />
      <Terminal.Screenshot name="layout-medium" />
      <Terminal.WaitForText text="SIDEKICK" row={1} as="mediumTab" />
      <Terminal.Click at={mediumTab} />
      <Terminal.Resize columns={72} rows={20} />
      <Terminal.WaitForText text="* Sidekick" row={1} />
      <Terminal.WaitForText text="message the sidekick" as="composer" />
      <Terminal.WaitForText text="No entry yet" as="round" />
      <AssertEquals actual={round.row > composer.row} expected={true} />
      <Terminal.WaitForText text="TRANSCRIPT" row={1} present={false} />
      <Terminal.WaitForText text="HISTORY" row={18} />
      <Terminal.Screenshot name="layout-narrow" />
    </XMD.Repl>
  </Terminal>
</Test>

<Test name="#971 Sidekick is the default and the TODO tab counts open items" timeout="45s">
  <Terminal columns={160} rows={36}>
    <XMD.Repl sidekick-agent={fixtureRoot + "/repl-ui-layout.md"}>
      <Terminal.WaitForText text="TODO" row={1} />
      <Terminal.WaitForText text="TODO 0" row={1} present={false} />
      <XMD.Repl.SidekickPrompt text="Populate the TODO list." as="turn" />
      <AssertStringIncludes actual={turn.output} expected="Four TODOs saved." />
      <Terminal.WaitForText text="TODO 4" as="todoTab" />
      <Terminal.WaitForText text="Four TODOs saved." />
      <Terminal.WaitForText text="Waiting messages are kept only in this REPL" present={false} />
      <Terminal.Screenshot name="fresh" />

      <Terminal.Click at={todoTab} />
      <Terminal.WaitForText text="☐ Reproduce checkout" />
      <Terminal.Screenshot name="todo-four-open" />
      <Terminal.Key key="ArrowDown" />
      <Terminal.WaitForText text="> ☐ Reproduce checkout" />
      <Terminal.Type text=" " />
      <Terminal.WaitForText text="☑ Reproduce checkout" />
      <Terminal.WaitForText text="TODO 3" />
      <Terminal.Screenshot name="todo-three-open" />
      <Terminal.WaitForText text="SIDEKICK" row={1} as="sidekickTab" />
      <Terminal.Click at={sidekickTab} />
      <Terminal.WaitForText text="TODO change acknowledged." />
      <XMD.Repl.SidekickPrompt text="Finish the remaining TODOs." as="finished" />
      <AssertStringIncludes actual={finished.output} expected="All TODOs complete." />
      <Terminal.Click at={todoTab} />
      <Terminal.WaitForText text="☑ Review checkout" />
      <Terminal.WaitForText text="TODO" row={1} />
      <Terminal.WaitForText text="TODO 0" row={1} present={false} />
      <Terminal.WaitForText text="TODO 3" row={1} present={false} />
    </XMD.Repl>
  </Terminal>
</Test>

<Test name="#971 the waiting queue preserves order and disappears when empty" timeout="60s">
  <TempDir>
    <Terminal columns={160} rows={36}>
      <XMD.Repl sidekick-agent={fixtureRoot + "/repl-ui-queue.md"}>
        <Terminal.Focus target="sidekick-composer" />
        <Terminal.Type text="Start the held checkout round." />
        <Terminal.Key key="Enter" />
        <Terminal.WaitForText text="Queue gate held" />

        <Terminal.Focus target="sidekick-composer" />
        <Terminal.WaitForText text="Follow" as="controls" />
        <Terminal.WaitForText text="[stop]" row={controls.row} />
        <Terminal.WaitForText text="[send]" row={controls.row} />
        <Each in={["Wait for tax check.", "Send results later."]} let="message">
          <Terminal.Type text={message} />
          <Terminal.Key key="Enter" />
        </Each>
        <Terminal.WaitForText text="[U] Send results later." />
        <Terminal.WaitForText text="Waiting messages are kept only in this REPL" as="notice" />
        <Terminal.WaitForText text="[U] Wait for tax check." as="firstWaiting" />
        <Terminal.WaitForText text="[U] Send results later." as="secondWaiting" />
        <AssertEquals actual={firstWaiting.row} expected={notice.row + 1} />
        <AssertEquals actual={secondWaiting.row} expected={firstWaiting.row + 1} />
        <Terminal.WaitForText text="QUEUE 2/" present={false} />
        <Terminal.Screenshot name="queue-two-waiting" />

        <File path="queue-release">release</File>
        <Terminal.WaitForText text="Follow gate held" />
        <Terminal.WaitForText text="Waiting messages are kept only in this REPL" as="remaining" />
        <Terminal.WaitForText text="Send results later." row={remaining.row + 1} />
        <Terminal.WaitForText text="Wait for tax check." row={remaining.row + 1} present={false} />
        <Terminal.Screenshot name="queue-one-waiting" />
        <Terminal.WaitForText text="X" row={remaining.row + 1} as="remove" />
        <Terminal.Click at={remove} />
        <Terminal.WaitForText text="Waiting messages are kept only in this REPL" present={false} />
        <Terminal.Screenshot name="queue-empty" />
        <File path="queue-final-release">release</File>
        <Terminal.WaitForText text="Follow fixture settled." />
      </XMD.Repl>
    </Terminal>
  </TempDir>
</Test>

<Test name="#971 a narrow queue scrolls to the last waiting message" timeout="60s">
  <TempDir>
    <Terminal columns={72} rows={20}>
      <XMD.Repl sidekick-agent={fixtureRoot + "/repl-ui-queue.md"}>
        <Terminal.Type text="Start the held checkout round." />
        <Terminal.Key key="Enter" />
        <Terminal.WaitForText text="1 ●" />
        <Terminal.Focus target="sidekick-composer" />
        <Each in={[1, 2, 3, 4, 5, 6, 7]} let="position">
          <Let as="message" value={"Waiting message " + position} />
          <Terminal.Region name="sidekick-composer">
            <Terminal.Type text={message} />
            <Terminal.WaitForText text={message} />
            <Terminal.Key key="Enter" />
            <Terminal.WaitForText text={message} present={false} />
          </Terminal.Region>
        </Each>
        <Terminal.WaitForText text="↓ more" />
        <Terminal.WaitForText text="Waiting message 1" as="first" />
        <Terminal.WaitForText text="Waiting message 7" present={false} />
        <Terminal.Screenshot name="long-queue-top" />
        <Terminal.Scroll delta={1} at={first} />
        <Terminal.WaitForText text="Waiting message 4" as="next" />
        <Terminal.Scroll delta={1} at={next} />
        <Terminal.WaitForText text="↑ more" />
        <Terminal.WaitForText text="Waiting message 7" />
        <Terminal.Screenshot name="long-queue-bottom" />
      </XMD.Repl>
    </Terminal>
  </TempDir>
</Test>
