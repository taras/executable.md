<Test name="capture the focused Sidekick composer" timeout="30s">
  <Cwd as="checkout" />
  <XMD.Build checkout={checkout}>
    <Terminal columns={72} rows={20}>
      <XMD.Repl>
        <Terminal.Focus target="sidekick-composer" />
        <Terminal.Type text="visual-bench-marker;" />
        <Terminal.Region name="sidekick-composer">
          <Terminal.WaitForText text="visual-bench-marker;" />
        </Terminal.Region>
        <Terminal.Screenshot name="composer" as="screenshot" />
        <XMD.Repl.Revision as="revision" />
        <Output>
          <Json value={{checkpoint: "focused-composer", revision, columns: 72, rows: 20, screenshot}} />
        </Output>
      </XMD.Repl>
    </Terminal>
  </XMD.Build>
</Test>
