<Test name="a child REPL captures its own profile between two entries" timeout="120s">
  <Terminal columns={120} rows={30}>
    <XMD.Repl plugins={["examples/xmd-profile/plugin.ts"]}>
      <Terminal.WaitForText text="Ready for Entry 1" />
      <Repl.Focus.Draft />
      <Terminal.Key key="Enter" />
      <Terminal.Type text={"<Profile.Start label=\"repl-typing\" />"} />
      <Terminal.WaitForText text="Start label" />
      <Terminal.Key key="Tab" />
      <Terminal.WaitForText text="> Send" />
      <Terminal.Key key="Enter" />
      <Terminal.WaitForText text="Ready for Entry 2" />
      <Terminal.Focus target="sidekick-composer" />
      <Terminal.Type text="profile typing marker" />
      <Terminal.Region name="sidekick-composer">
        <Terminal.WaitForText text="typing marker" />
      </Terminal.Region>
      <Repl.Focus.Draft />
      <Terminal.Key key="Enter" />
      <Terminal.Type text={"<Profile.Stop label=\"repl-typing\" />"} />
      <Terminal.WaitForText text="Stop label" />
      <Terminal.Key key="Tab" />
      <Terminal.WaitForText text="> Send" />
      <Terminal.Key key="Enter" />
      <Terminal.WaitForText text="Ready for Entry 3" />
    </XMD.Repl>
  </Terminal>
  <Profile.Report path=".bench/profile/repl-typing.cpuprofile" as="report" />
  <AssertGreater actual={report.samples} expected={0} />
  <AssertGreater actual={report.activeUs} expected={0} />
</Test>