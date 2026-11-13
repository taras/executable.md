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

<Test name="submitting the Draft shows its result and settled History mark">
  <ReplBench columns={160} rows={36} expectExit={true} as="closed">
    <ReplBench.WaitForText text="> DRAFT" />
    <ReplBench.WaitForText text="HEAD · EMPTY" />
    <ReplBench.Type text={'```js eval\nconst count = 6 * 7;\n```\n\nDraft result {count}'} />
    <ReplBench.WaitForText text="Draft result {count}" />
    <ReplBench.Key key="Enter" />
    <ReplBench.WaitForText text="HEAD · SETTLED" />
    <ReplBench.WaitForText text="✓ COMPLETED" />
    <ReplBench.WaitForText text="Draft result 42" />
    <ReplBench.Key key="Ctrl+C" />
  </ReplBench>
  <AssertEquals actual={closed.exitCode} expected={0} />
  <AssertStringIncludes actual={closed.location} expected="xmd://repl/" />
</Test>

<Test name="History takes focus and the Draft survives narrow and wide layouts">
  <ReplBench columns={160} rows={36} expectExit={true} as="closed">
    <ReplBench.WaitForText text="> DRAFT" />
    <ReplBench.Type text="draft survives" />
    <ReplBench.WaitForText text="draft survives" />
    <ReplBench.Key key="Shift+Tab" />
    <ReplBench.WaitForText text="> Entries" />
    <ReplBench.Key key="Shift+Tab" />
    <ReplBench.WaitForText text="> All sessions" />
    <ReplBench.Key key="Shift+Tab" />
    <ReplBench.WaitForText text="> [history]" />
    <ReplBench.Key key="Enter" />
    <ReplBench.WaitForText text="[close]" />
    <ReplBench.Type text="stray input" />
    <ReplBench.Key key="Escape" />
    <ReplBench.WaitForText text="[close]" present={false} />
    <ReplBench.Resize columns={72} rows={20} />
    <ReplBench.WaitForText text="* Entries" />
    <ReplBench.WaitForText text="DRAFT" as="narrowDraft" />
    <ReplBench.WaitForText text="draft survives" at={{ row: narrowDraft.row + 1, column: narrowDraft.column - 2 }} />
    <ReplBench.Resize columns={160} rows={36} />
    <ReplBench.WaitForText text="TRANSCRIPT" />
    <ReplBench.WaitForText text="DRAFT" as="wideDraft" />
    <ReplBench.WaitForText text="draft survives" at={{ row: wideDraft.row + 1, column: wideDraft.column - 2 }} />
    <ReplBench.WaitForText text="stray input" present={false} />
    <ReplBench.Key key="Ctrl+C" />
  </ReplBench>
  <AssertEquals actual={closed.exitCode} expected={0} />
  <AssertStringIncludes actual={closed.location} expected="/entries?draft=draft%20survives" />
</Test>

<Test name="Enter on the focused exit allows the settled entry to reopen">
  <ReplBench columns={160} rows={36} expectExit={true} as="closed">
    <ReplBench.Type text="Retained reading" />
    <ReplBench.WaitForText text="Retained reading" />
    <ReplBench.Key key="Enter" />
    <ReplBench.WaitForText text="1 ✓" />
    <ReplBench.Key key="Shift+Tab" />
    <ReplBench.WaitForText text="> Entries" />
    <ReplBench.Key key="Shift+Tab" />
    <ReplBench.WaitForText text="> All sessions" />
    <ReplBench.Key key="Shift+Tab" />
    <ReplBench.WaitForText text="> [history]" />
    <ReplBench.Key key="ArrowRight" />
    <ReplBench.WaitForText text="> [exit]" />
    <ReplBench.Key key="Enter" />
  </ReplBench>
  <AssertEquals actual={closed.exitCode} expected={0} />
  <AssertStringIncludes actual={closed.location} expected="xmd://repl/" />
  <ReplBench resume={closed.resume}>
    <ReplBench.WaitForText text="Retained reading" />
    <ReplBench.WaitForText text="1 ✓" />
    <ReplBench.WaitForText text="2 ✓" present={false} />
  </ReplBench>
</Test>
