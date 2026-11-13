<Test name="literal input reaches the focused Sidekick composer and Ctrl+C clears it before exit">
  <ReplBench columns={120} rows={30} expectExit={true} as="closed">
    <ReplBench.Type text="draft-only" />
    <ReplBench.WaitForText text="draft-only" />
    <ReplBench.Focus target="sidekick-composer" />
    <ReplBench.Type text={"bench first;\nbench second;"} />
    <ReplBench.Region name="sidekick-composer">
      <ReplBench.WaitForText text="draft-only" present={false} />
      <ReplBench.WaitForText text="bench first;" as="first" />
      <ReplBench.Region name="transcript">
        <ReplBench.WaitForText text="bench first;" present={false} />
        <ReplBench.WaitForText text="No retained turns" />
      </ReplBench.Region>
      <ReplBench.WaitForText text="bench first;" at={first} />
      <ReplBench.WaitForText text="bench second;" />
      <ReplBench.Key key="Ctrl+C" />
      <ReplBench.WaitForText text="bench first;" present={false} />
    </ReplBench.Region>
    <ReplBench.Key key="Ctrl+C" />
  </ReplBench>
  <AssertEquals actual={closed.exitCode} expected={0} />
  <AssertStringIncludes actual={closed.location} expected="xmd://repl/" />
</Test>

<Test name="a resized Sidekick view reopens at its last terminal size">
  <ReplBench columns={120} rows={30} expectExit={true} as="closed">
    <ReplBench.Focus target="sidekick-composer" />
    <ReplBench.Resize columns={72} rows={20} />
    <ReplBench.WaitForText text="Entries    * Sidekick" />
    <ReplBench.WaitForText text="message the sidekick" />
    <ReplBench.Key key="Ctrl+C" />
  </ReplBench>
  <AssertEquals actual={closed.exitCode} expected={0} />
  <AssertStringIncludes actual={closed.location} expected="view=sidekick" />
  <ReplBench resume={closed.resume}>
    <ReplBench.WaitForText text="Entries    * Sidekick" />
    <ReplBench.WaitForText text="message the sidekick" />
  </ReplBench>
</Test>

<Test name="the REPL entry uses the contextual temporary directory">
  <TempDir>
    <Cwd as="directory" />
    <File path="repl-fixture.txt">scoped-repl-fixture</File>
    <ReplBench columns={160} rows={36}>
      <ReplBench.Type text={"<Cwd />\n\n<File path=\"repl-fixture.txt\" />"} />
      <ReplBench.WaitForText text="repl-fixture.txt" />
      <ReplBench.Key key="Enter" />
      <ReplBench.WaitForText text="scoped-repl-fixture" />
      <ReplBench.WaitForText text={directory.slice(-24)} />
    </ReplBench>
  </TempDir>
</Test>
