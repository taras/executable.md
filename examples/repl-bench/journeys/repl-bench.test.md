<Test name="literal input reaches the focused Sidekick composer and Ctrl+C clears it before exit">
  <ReplBench columns={120} rows={30} expectExit={true} as="closed">
    <Repl.Focus.Draft />
    <ReplBench.Key key="Enter" />
    <ReplBench.Type text="draft-only" />
    <ReplBench.WaitForText text="draft-only" />
    <ReplBench.Focus target="sidekick-composer" />
    <ReplBench.Type text={"bench first;\nbench second;"} />
    <ReplBench.Region name="sidekick-composer">
      <ReplBench.WaitForText text="draft-only" present={false} />
      <ReplBench.WaitForText text="bench first;" as="first" />
      <ReplBench.Region name="transcript">
        <ReplBench.WaitForText text="bench first;" present={false} />
        <ReplBench.WaitForText text="(none retained)" />
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
    <Repl.Focus.Draft />
    <Repl.Sidekick.Activate />
    <ReplBench.Resize columns={72} rows={20} />
    <ReplBench.WaitForText text="Entries    * Sidekick" />
    <ReplBench.Region name="sidekick-composer">
      <ReplBench.WaitForText text="Send sidekick a message" />
    </ReplBench.Region>
    <Terminal.Screenshot name="narrow-sidekick" as="image" />
    <AssertStringIncludes actual={image} expected="/narrow-sidekick.svg" />
    <File path={image.slice(directory.length + 1)} as="svg" />
    <AssertMatch actual={svg} expected={/^<svg .* viewBox="0 0 [\d.]+ 400"/} />
    <AssertStringIncludes actual={svg} expected="Send sidekick a message" />
    <ReplBench.Key key="Ctrl+C" />
  </ReplBench>
  <AssertEquals actual={closed.exitCode} expected={0} />
  <AssertStringIncludes actual={closed.location} expected="view=sidekick" />
  <ReplBench resume={closed.resume}>
    <ReplBench.WaitForText text="Entries    * Sidekick" />
    <ReplBench.Region name="sidekick-composer">
      <ReplBench.WaitForText text="Send sidekick a message" />
    </ReplBench.Region>
  </ReplBench>
</Test>

<Test name="the REPL entry uses the contextual temporary directory">
  <TempDir>
    <Cwd as="directory" />
    <File path="repl-fixture.txt">scoped-repl-fixture</File>
    <ReplBench columns={160} rows={36}>
      <Repl.Focus.Draft />
      <ReplBench.Key key="Enter" />
      <ReplBench.Type text={'<Cwd as="directory" />\n<Let as="basename" value={directory.split("/").at(-1)} />\n\nDir {basename}\n\n<File path="repl-fixture.txt" />'} />
      <ReplBench.WaitForText text="repl-fixture.txt" />
      <ReplBench.Key key="Tab" />
      <ReplBench.Key key="Enter" />
      <ReplBench.WaitForText text="scoped-repl-fixture" />
      <ReplBench.WaitForText text={directory.split("/").at(-1)} />
    </ReplBench>
  </TempDir>
</Test>

<Test name="submitting the Draft shows its result and settled History mark">
  <ReplBench columns={160} rows={36} expectExit={true} as="closed">
    <Repl.Focus.Draft />
    <ReplBench.Key key="Enter" />
    <ReplBench.WaitForText text="> Round" />
    <ReplBench.WaitForText text="HEAD · EMPTY" />
    <ReplBench.Type text={'```js eval\nconst count = 6 * 7;\n```\n\nDraft result {count}'} />
    <ReplBench.WaitForText text="Draft result {count}" />
    <ReplBench.Key key="Tab" />
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
    <Repl.Focus.Draft />
    <ReplBench.Key key="Enter" />
    <ReplBench.WaitForText text="> Round" />
    <ReplBench.Type text="draft survives" />
    <ReplBench.WaitForText text="│ draft survives" />
    <ReplBench.Key key="Home" />
    <Repl.Focus.History />
    <ReplBench.WaitForText text="> [History]" />
    <ReplBench.Key key="Enter" />
    <ReplBench.WaitForText text="[close]" />
    <ReplBench.Type text="stray input" />
    <ReplBench.Key key="Escape" />
    <ReplBench.WaitForText text="[close]" present={false} />
    <ReplBench.Resize columns={72} rows={20} />
    <ReplBench.WaitForText text="* Entries" row={1} />
    <ReplBench.WaitForText text="[exit]" row={19} />
    <ReplBench.WaitForText text="· draft" as="narrowDraft" />
    <ReplBench.WaitForText text="│ draft survives" as="narrowValue" />
    <AssertEquals actual={Math.sign(narrowValue.row - narrowDraft.row)} expected={1} />
    <ReplBench.Resize columns={160} rows={36} />
    <ReplBench.WaitForText text="TRANSCRIPT" row={1} />
    <ReplBench.WaitForText text="[exit]" row={35} />
    <ReplBench.WaitForText text="· draft" as="wideDraft" />
    <ReplBench.WaitForText text="│ draft survives" as="wideValue" />
    <AssertEquals actual={Math.sign(wideValue.row - wideDraft.row)} expected={1} />
    <ReplBench.WaitForText text="stray input" present={false} />
    <Repl.Focus.Draft />
    <ReplBench.Type text="caret " />
    <ReplBench.WaitForText text="│ caret draft survives" />
    <ReplBench.Region name="sidekick-composer">
      <ReplBench.WaitForText text="draft survives" present={false} />
    </ReplBench.Region>
    <ReplBench.Key key="Ctrl+C" />
  </ReplBench>
  <AssertEquals actual={closed.exitCode} expected={0} />
  <AssertStringIncludes actual={closed.location} expected="/entries?draft=caret%20draft%20survives" />
</Test>

<Test name="Enter on the focused exit allows the settled entry to reopen">
  <ReplBench columns={160} rows={36} expectExit={true} as="closed">
    <Repl.Focus.Draft />
    <ReplBench.Key key="Enter" />
    <ReplBench.Type text="Retained reading" />
    <ReplBench.WaitForText text="Retained reading" />
    <ReplBench.Key key="Tab" />
    <ReplBench.Key key="Enter" />
    <ReplBench.WaitForText text="1 ✓" />
    <Repl.Focus.History />
    <ReplBench.WaitForText text="> [History]" />
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
    <Repl.Focus.Draft />
    <ReplBench.Key key="Enter" />
    <ReplBench.WaitForText text="> Round" as="draft" />
    <ReplBench.Region name="sidekick-composer" focused={false}>
      <ReplBench.WaitForText text="Send sidekick a message" as="composer" />
    </ReplBench.Region>
    <ReplBench.WaitForText text="[send]" row={composer.row-2} as="sidekickSend" />
    <ReplBench.WaitForText text="No messages yet." />
    <ReplBench.Type text="Draft Send witness" />
    <ReplBench.WaitForText text="│ Draft Send witness" as="draftValue" />
    <AssertEquals actual={Math.sign(draftValue.row - draft.row)} expected={1} />
    <ReplBench.Region name="sidekick-composer">
      <ReplBench.WaitForText text="Draft Send witness" present={false} />
    </ReplBench.Region>
    <ReplBench.WaitForText text="✎ draft" as="bar" />
    <ReplBench.WaitForText text="Send" row={bar.row} as="draftSend" />
    <ReplBench.Click at={draftSend} />
    <ReplBench.WaitForText text="1 ✓" />
    <ReplBench.WaitForText text="✓ COMPLETED" />
    <ReplBench.WaitForText text="✎ draft" present={false} />
    <ReplBench.WaitForText text="│ Draft Send witness" present={false} />
    <ReplBench.WaitForText text="Output" as="sentOutput" />
    <ReplBench.WaitForText text="Draft Send witness" row={sentOutput.row+1} />
    <ReplBench.WaitForText text="[send]" at={sidekickSend} />
    <ReplBench.WaitForText text="No messages yet." />
    <ReplBench.Region name="transcript">
      <ReplBench.WaitForText text="── Round 1 ──" />
    </ReplBench.Region>
  </ReplBench>
</Test>

<Test name="the Draft survives all layouts and submits after the minimum-size refusal">
  <ReplBench columns={160} rows={36}>
    <Repl.Focus.Draft />
    <ReplBench.Key key="Enter" />
    <ReplBench.WaitForText text="> Round" as="beforeResize" />
    <ReplBench.Type text="Draft kept through resize" />
    <ReplBench.WaitForText text="│ Draft kept through resize" />
    <ReplBench.Key key="Home" />

    <ReplBench.Resize columns={120} rows={30} />
    <ReplBench.WaitForText text="[History]" row={29} />
    <ReplBench.WaitForText text="> Round" as="medium" />
    <ReplBench.WaitForText text="│ Draft kept through resize" as="mediumValue" />
    <AssertEquals actual={Math.sign(mediumValue.row - medium.row)} expected={1} />

    <ReplBench.Resize columns={72} rows={20} />
    <ReplBench.WaitForText text="* Entries" />
    <ReplBench.WaitForText text="> Round" as="narrow" />
    <ReplBench.WaitForText text="│ Draft kept through resize" as="narrowValue" />
    <AssertEquals actual={Math.sign(narrowValue.row - narrow.row)} expected={1} />
    <ReplBench.WaitForText text="✎ draft" as="narrowBar" />
    <ReplBench.WaitForText text="Send" row={narrowBar.row} />
    <ReplBench.WaitForText text="SIDEKICK" present={false} />
    <ReplBench.WaitForText text="Send sidekick a message" present={false} />

    <ReplBench.Resize columns={40} rows={10} />
    <ReplBench.WaitForText text="needs at least 72x20" />
    <ReplBench.WaitForText text="larger" />
    <ReplBench.WaitForText text="Draft kept through resize" present={false} />
    <ReplBench.WaitForText text="[send]" present={false} />

    <ReplBench.Resize columns={160} rows={36} />
    <ReplBench.WaitForText text="> All sessions" />
    <ReplBench.WaitForText text="· draft" as="wide" />
    <ReplBench.WaitForText text="│ Draft kept through resize" as="wideValue" />
    <AssertEquals actual={Math.sign(wideValue.row - wide.row)} expected={1} />
    <Repl.Focus.Draft />
    <ReplBench.WaitForText text="> Round" />
    <ReplBench.Type text="Caret: " />
    <ReplBench.WaitForText text="│ Caret: Draft kept through resize" />
    <ReplBench.Key key="Tab" />
    <ReplBench.WaitForText text="> Send" />
    <ReplBench.Key key="Enter" />
    <ReplBench.WaitForText text="HEAD · SETTLED" />
    <ReplBench.WaitForText text="✓ COMPLETED" />
    <ReplBench.WaitForText text="✎ draft" present={false} />
    <ReplBench.WaitForText text="Output" as="sentOutput" />
    <ReplBench.WaitForText text="Caret: Draft kept through" row={sentOutput.row+1} />
    <ReplBench.WaitForText text="resize" row={sentOutput.row+2} />
  </ReplBench>
</Test>
