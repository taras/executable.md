<Test name="literal input reaches the focused Sidekick composer and Ctrl+C clears it before exit">
  <ReplBench columns={120} rows={30} expectExit={true} as="closed">
    <Terminal.Key key="Ctrl+G" />
    <Terminal.Key key="4" />
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
    <Cwd as="directory" />
    <Terminal.WaitForText text="SIDEKICK" row={1} as="sidekickTab" />
    <Terminal.Click at={sidekickTab} />
    <ReplBench.Resize columns={72} rows={20} />
    <ReplBench.WaitForText text="Entries    * Sidekick" />
    <ReplBench.WaitForText text="message the sidekick" />
    <Terminal.Screenshot name="narrow-sidekick" as="image" />
    <AssertStringIncludes actual={image} expected="/narrow-sidekick.svg" />
    <File path={image.slice(directory.length + 1)} as="svg" />
    <AssertMatch actual={svg} expected={/^<svg .* viewBox="0 0 [\d.]+ 400"/} />
    <AssertStringIncludes actual={svg} expected="message the sidekick" />
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
      <Terminal.Key key="Ctrl+G" />
      <Terminal.Key key="4" />
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
    <Terminal.Key key="Ctrl+G" />
    <Terminal.Key key="4" />
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
    <Terminal.Key key="Ctrl+G" />
    <Terminal.Key key="4" />
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
    <ReplBench.WaitForText text="* Entries" row={1} />
    <ReplBench.WaitForText text="[exit]" row={18} />
    <ReplBench.WaitForText text="DRAFT" as="narrowDraft" />
    <ReplBench.WaitForText text="draft survives" at={{ row: narrowDraft.row + 1, column: narrowDraft.column - 2 }} />
    <ReplBench.Resize columns={160} rows={36} />
    <ReplBench.WaitForText text="TRANSCRIPT" row={1} />
    <ReplBench.WaitForText text="[exit]" row={34} />
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
    <Terminal.Key key="Ctrl+G" />
    <Terminal.Key key="4" />
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


<Test name="the visible Draft Send submits its entry and leaves Sidekick idle">
  <ReplBench columns={160} rows={36}>
    <Terminal.Key key="Ctrl+G" />
    <Terminal.Key key="4" />
    <ReplBench.WaitForText text="> DRAFT" as="draft" />
    <ReplBench.WaitForText text="message the sidekick" as="composer" />
    <ReplBench.WaitForText text="[send]" row={composer.row-1} as="sidekickSend" />
    <ReplBench.WaitForText text="No messages yet." />
    <ReplBench.Type text="Draft Send witness" />
    <ReplBench.WaitForText text="Draft Send witness" row={draft.row+1} />
    <ReplBench.Region name="sidekick-composer">
      <ReplBench.WaitForText text="Draft Send witness" present={false} />
    </ReplBench.Region>
    <ReplBench.WaitForText text="[send]" row={draft.row} as="draftSend" />
    <ReplBench.Click at={draftSend} />
    <ReplBench.WaitForText text="1 ✓" />
    <ReplBench.WaitForText text="✓ COMPLETED" />
    <ReplBench.WaitForText text="Draft Send witness" row={draft.row+1} present={false} />
    <ReplBench.WaitForText text="Draft Send witness" />
    <ReplBench.WaitForText text="[send]" at={sidekickSend} />
    <ReplBench.WaitForText text="No messages yet." />
    <ReplBench.Region name="transcript">
      <ReplBench.WaitForText text="No retained turns" />
    </ReplBench.Region>
  </ReplBench>
</Test>

<Test name="the Draft survives all layouts and submits after the minimum-size refusal">
  <ReplBench columns={160} rows={36}>
    <Terminal.Key key="Ctrl+G" />
    <Terminal.Key key="4" />
    <ReplBench.WaitForText text="> DRAFT" as="beforeResize" />
    <ReplBench.Type text="Draft kept through resize" />
    <ReplBench.WaitForText text="Draft kept through resize" />

    <ReplBench.Resize columns={120} rows={30} />
    <ReplBench.WaitForText text="Type here" row={29} />
    <ReplBench.WaitForText text="> DRAFT" as="medium" />
    <AssertEquals actual={medium.row < beforeResize.row} expected={true} />
    <ReplBench.WaitForText text="Draft kept through resize" row={medium.row+1} />

    <ReplBench.Resize columns={72} rows={20} />
    <ReplBench.WaitForText text="* Entries" />
    <ReplBench.WaitForText text="> DRAFT" as="narrow" />
    <ReplBench.WaitForText text="Draft kept through resize" row={narrow.row+1} />
    <ReplBench.WaitForText text="Type here" />
    <ReplBench.WaitForText text="[send]" as="narrowSend" />
    <ReplBench.WaitForText text="[send]" row={narrow.row} at={narrowSend} />
    <ReplBench.WaitForText text="SIDEKICK" present={false} />
    <ReplBench.WaitForText text="message the sidekick" present={false} />

    <ReplBench.Resize columns={40} rows={10} />
    <ReplBench.WaitForText text="needs at least 72x20" />
    <ReplBench.WaitForText text="larger" />
    <ReplBench.WaitForText text="Draft kept through resize" present={false} />
    <ReplBench.WaitForText text="[send]" present={false} />

    <ReplBench.Resize columns={160} rows={36} />
    <ReplBench.WaitForText text="> All sessions" />
    <ReplBench.WaitForText text="DRAFT" as="wide" />
    <ReplBench.WaitForText text="Draft kept through resize" row={wide.row+1} />
    <ReplBench.Key key="Tab" />
    <ReplBench.WaitForText text="> Entries" />
    <ReplBench.Key key="Tab" />
    <ReplBench.WaitForText text="> DRAFT" />
    <ReplBench.WaitForText text="Type here" />
    <ReplBench.Key key="Enter" />
    <ReplBench.WaitForText text="HEAD · SETTLED" />
    <ReplBench.WaitForText text="✓ COMPLETED" />
    <ReplBench.WaitForText text="Draft kept through resize" row={wide.row+1} present={false} />
    <ReplBench.WaitForText text="Draft kept through resize" />
  </ReplBench>
</Test>
