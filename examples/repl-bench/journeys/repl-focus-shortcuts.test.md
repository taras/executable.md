<Test name="startup and numbered focus preserve both drafts and tab selection">
  <Terminal columns={160} rows={36}>
    <ReplBench>
      <Terminal.Type text="startup-message" />
      <Terminal.Region name="sidekick-composer">
        <Terminal.WaitForText text="startup-message" />
      </Terminal.Region>

      <Terminal.Key key="Ctrl+G" />
      <Terminal.Type text="4" />
      <Terminal.Key key="2" />
      <Terminal.Type text="-suffix" />
      <Terminal.Region name="sidekick-composer" focused={true}>
        <Terminal.WaitForText text="startup-message42-suffix" />
      </Terminal.Region>

      <Repl.Focus.Draft />
      <Terminal.Key key="Enter" />
      <Terminal.WaitForText text="> Round 1 · draft" />
      <Terminal.Type text="entry-draft" />
      <Terminal.WaitForText text="│ entry-draft" />
      <Terminal.Key key="Home" />

      <Terminal.Key key="Tab" />
      <Terminal.WaitForText text="> Send" bold={true} />
      <Terminal.Region name="sidekick-composer" focused={false}>
        <Terminal.WaitForText text="startup-message42-suffix" />
      </Terminal.Region>
      <Terminal.Key key="Shift+Tab" />
      <Terminal.WaitForText text="> Round 1 · draft" />
      <Terminal.WaitForText text="> BINDINGS" present={false} />
      <Terminal.Type text="pre-" />
      <Terminal.WaitForText text="│ pre-entry-draft" />

      <Repl.Focus.Message />
      <Terminal.Region name="sidekick-composer" focused={true}>
        <Terminal.WaitForText text="startup-message42-suffix" />
      </Terminal.Region>
      <Terminal.Type text="-more" />
      <Terminal.Region name="sidekick-composer">
        <Terminal.WaitForText text="startup-message42-suffix-more" />
        <Terminal.WaitForText text="entry-draft" present={false} />
      </Terminal.Region>
      <Terminal.WaitForText text="entry-draft" count={1} />
    </ReplBench>
  </Terminal>
</Test>

<Test name="narrow shortcuts reveal the destination and stay inside a modal">
  <Terminal columns={72} rows={20}>
    <ReplBench>
      <Terminal.Type text="narrow-message" />
      <Terminal.Region name="sidekick-composer">
        <Terminal.WaitForText text="narrow-message" />
      </Terminal.Region>
      <Repl.Focus.Draft />
      <Terminal.Key key="Enter" />
      <Terminal.WaitForText text="> Round 1 · draft" />
      <Terminal.Type text="narrow-draft" />
      <Terminal.WaitForText text="│ narrow-draft" />
      <Try>
        <Repl.Focus.Tabs />
        <Fail message="The narrow viewport does not offer the Tabs shortcut" />
        <Catch as="unavailable">
          <AssertStringIncludes actual={unavailable.message} expected="Focus shortcut [5] is unavailable" />
        </Catch>
      </Try>
      <Terminal.Key key="Escape" />
      <Terminal.WaitForText text="move focus · Esc closes" present={false} />
      <Terminal.Type text="-kept" />
      <Terminal.WaitForText text="│ narrow-draft-kept" />
      <Terminal.Key key="Home" />

      <Repl.Focus.History />
      <Terminal.WaitForText text="> [History]" bold={true} />
      <Terminal.Key key="Enter" />
      <Terminal.WaitForText text="[close]" />
      <Terminal.Key key="Ctrl+G" />
      <Terminal.Key key="1" />
      <Terminal.WaitForText text="[close]" />
      <Terminal.WaitForText text="narrow-message" present={false} />
      <Terminal.Key key="Escape" />
      <Terminal.WaitForText text="[close]" present={false} />

      <Repl.Focus.Message />
      <Terminal.Region name="sidekick-composer" focused={true}>
        <Terminal.WaitForText text="narrow-message" />
      </Terminal.Region>
      <Terminal.Type text="-kept" />
      <Terminal.Region name="sidekick-composer">
        <Terminal.WaitForText text="narrow-message-kept" />
      </Terminal.Region>
      <Repl.Focus.Draft />
      <Terminal.WaitForText text="> Round 1 · draft" />
      <Terminal.Type text="^" />
      <Terminal.WaitForText text="│ ^narrow-draft-kept" />
    </ReplBench>
  </Terminal>
</Test>

<Test name="named focus components enter the corresponding terminal regions">
  <Terminal columns={160} rows={36}>
    <XMD.Repl>
      <Repl.Focus.Transcript />
      <Terminal.WaitForText text="> All sessions" />
      <Repl.Focus.SelectedWork />
      <Terminal.WaitForText text="> Entries" />
      <Repl.Focus.Draft />
      <Terminal.WaitForText text="> + New Round" />
      <Repl.Focus.Tabs />
      <Terminal.WaitForText text="> BINDINGS" />
      <Repl.Focus.RightReading />
      <Terminal.WaitForText text="No messages yet." bold={true} />
      <Repl.Focus.Todo />
      <Terminal.WaitForText text="> TODO" />
      <Repl.Focus.History />
      <Terminal.WaitForText text="> [History]" />
      <Repl.Focus.Message />
      <Terminal.Region name="sidekick-composer" focused={true}>
        <Terminal.WaitForText text="Send sidekick a message" />
      </Terminal.Region>
      <Terminal.Resize columns={72} rows={20} />
      <Terminal.WaitForText text="Sessions" row={1} />
      <Repl.Focus.Draft />
      <Terminal.WaitForText text="> + New Round" />
      <Repl.Focus.SurfaceBar />
      <Terminal.WaitForText text=">   Sessions" row={1} />
    </XMD.Repl>
  </Terminal>
</Test>
