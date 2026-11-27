# REPL focus hints

Run this acceptance document with the REPL Bench plugin. The expected screens are in the v8 handoff under `focus-hints`.

<Test name="wide focus hints preserve drafts and clear on a jump or Escape" timeout="30s">
  <Terminal columns={160} rows={36}>
    <XMD.Repl>
      <Terminal.Type text="unsent-message" />
      <Terminal.Region name="sidekick-composer">
        <Terminal.WaitForText text="unsent-message" />
      </Terminal.Region>

      <Repl.Focus.Draft />
      <Terminal.Key key="Enter" />
      <Terminal.WaitForText text="· draft" bold={true} />
      <Terminal.Type text="unsent-entry" />
      <Terminal.WaitForText text="unsent-entry" />
      <Repl.Focus.Message />

      <Terminal.Key key="Ctrl+G" />
      <Each in={[1, 2, 3, 4, 5, 6, 7, 8]} let="key">
        <Terminal.WaitForText text={"[" + key + "]"} bold={true} />
      </Each>
      <Terminal.WaitForText text="[9]" present={false} />
      <Terminal.Screenshot name="wide-hints" />

      <Terminal.Key key="9" />
      <Terminal.WaitForText text="[1]" bold={true} />
      <Terminal.Key key="4" />
      <Terminal.WaitForText text="· draft" bold={true} />
      <Terminal.WaitForText text="[1]" present={false} />
      <Terminal.WaitForText text="unsent-entry" />

      <Repl.Focus.Message />
      <Terminal.Key key="Ctrl+G" />
      <Terminal.WaitForText text="[1]" bold={true} />
      <Terminal.Key key="Escape" />
      <Terminal.WaitForText text="[1]" present={false} />
      <Terminal.Type text="-kept" />
      <Terminal.Region name="sidekick-composer">
        <Terminal.WaitForText text="unsent-message-kept" />
      </Terminal.Region>

      <Terminal.Key key="Ctrl+G" />
      <Terminal.WaitForText text="[1]" bold={true} />
      <Terminal.Key key="Ctrl+G" />
      <Terminal.WaitForText text="[1]" present={false} />
    </XMD.Repl>
  </Terminal>
</Test>

<Test name="narrow focus hints reveal Sessions and return to the Sidekick composer" timeout="30s">
  <Terminal columns={72} rows={20}>
    <XMD.Repl>
      <Terminal.Type text="narrow-message" />
      <Terminal.Region name="sidekick-composer">
        <Terminal.WaitForText text="narrow-message" />
      </Terminal.Region>

      <Terminal.Key key="Ctrl+G" />
      <Terminal.WaitForText text="[1]" bold={true} />
      <Terminal.WaitForText text="opens Sessions" />
      <Terminal.WaitForText text="opens Entries" />
      <Terminal.Screenshot name="narrow-hints" />
      <Terminal.Key key="2" />
      <Terminal.WaitForText text="* Sessions" row={1} />
      <Terminal.WaitForText text="opens Sessions" present={false} />
      <Terminal.Screenshot name="narrow-sessions" />

      <Terminal.Key key="Ctrl+G" />
      <Terminal.WaitForText text="[1] Message · opens Sidekick" />
      <Terminal.Key key="1" />
      <Terminal.Type text="-kept" />
      <Terminal.Region name="sidekick-composer">
        <Terminal.WaitForText text="narrow-message-kept" />
      </Terminal.Region>
    </XMD.Repl>
  </Terminal>
</Test>

<Test name="the History drawer owns focus and Escape while shortcuts are unavailable" timeout="30s">
  <Terminal columns={72} rows={20}>
    <XMD.Repl>
      <Repl.Focus.History />
      <Terminal.Key key="Enter" />
      <Terminal.WaitForText text="[close]" />
      <Terminal.Key key="Ctrl+G" />
      <Terminal.WaitForText text="[1]" present={false} />
      <Terminal.Key key="1" />
      <Terminal.WaitForText text="[close]" />
      <Terminal.Region name="sidekick-composer" focused={false}>
        <Terminal.WaitForText text="Send sidekick a message" />
      </Terminal.Region>
      <Terminal.Key key="Ctrl+G" />
      <Terminal.Key key="Escape" />
      <Terminal.WaitForText text="[close]" present={false} />
    </XMD.Repl>
  </Terminal>
</Test>
