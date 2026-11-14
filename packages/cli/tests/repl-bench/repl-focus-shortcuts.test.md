<Test name="startup and numbered focus preserve both drafts and tab selection">
  <Terminal columns={160} rows={36}>
    <ReplBench>
      <Terminal.Type text="startup-message" />
      <Terminal.Region name="sidekick-composer">
        <Terminal.WaitForText text="startup-message" />
      </Terminal.Region>

      <Terminal.Key key="Ctrl+G" />
      <Terminal.Key key="4" />
      <Terminal.WaitForText text="> DRAFT" bold={true} />
      <Terminal.Type text="entry-draft" />
      <Terminal.WaitForText text="entry-draft" />

      <Terminal.Key key="Tab" />
      <Terminal.WaitForText text="> BINDINGS" bold={true} />
      <Terminal.WaitForText text="message the sidekick" bold={false} />
      <Terminal.Key key="Shift+Tab" />
      <Terminal.WaitForText text="> DRAFT" bold={true} />
      <Terminal.WaitForText text="> BINDINGS" present={false} />

      <Terminal.Key key="Ctrl+G" />
      <Terminal.Key key="1" />
      <Terminal.WaitForText text="message the sidekick" bold={true} />
      <Terminal.Type text="-more" />
      <Terminal.Region name="sidekick-composer">
        <Terminal.WaitForText text="startup-message-more" />
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
      <Terminal.Key key="Ctrl+G" />
      <Terminal.Key key="4" />
      <Terminal.WaitForText text="> DRAFT" bold={true} />
      <Terminal.Type text="narrow-draft" />
      <Terminal.Key key="Ctrl+G" />
      <Terminal.Key key="5" />
      <Terminal.WaitForText text="> DRAFT" bold={true} />
      <Terminal.Type text="-kept" />
      <Terminal.WaitForText text="narrow-draft-kept" />

      <Terminal.Key key="Ctrl+G" />
      <Terminal.Key key="8" />
      <Terminal.WaitForText text="> [history]" bold={true} />
      <Terminal.Key key="Enter" />
      <Terminal.WaitForText text="[close]" />
      <Terminal.Key key="Ctrl+G" />
      <Terminal.Key key="1" />
      <Terminal.WaitForText text="[close]" />
      <Terminal.WaitForText text="message the sidekick" present={false} />
      <Terminal.Key key="Escape" />
      <Terminal.WaitForText text="[close]" present={false} />

      <Terminal.Key key="Ctrl+G" />
      <Terminal.Key key="1" />
      <Terminal.WaitForText text="message the sidekick" bold={true} />
      <Terminal.Type text="-kept" />
      <Terminal.Region name="sidekick-composer">
        <Terminal.WaitForText text="narrow-message-kept" />
      </Terminal.Region>
      <Terminal.Key key="Ctrl+G" />
      <Terminal.Key key="4" />
      <Terminal.WaitForText text="> DRAFT" bold={true} />
      <Terminal.WaitForText text="narrow-draft-kept" />
    </ReplBench>
  </Terminal>
</Test>
