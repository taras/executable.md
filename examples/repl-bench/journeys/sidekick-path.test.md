<Test name="an explicit Sidekick path resolves from the contextual cwd for each child" timeout="60s">
  <Let as="behavior" select="code">
  ````markdown
  <WhenPrompt template="{?context}Initialize this Sidekick for an ACP attachment.{?rest}" />

  <Let as="ready" select="code">
  ```xmd
  <Output>Fixture ready.</Output>
  ```
  </Let>
  {ready}

  <WhenPrompt template={"{?context}The person says:\n\nfixture witness"} />

  <Let as="reply" select="code">
  ```xmd
  <Output>Answer from the selected fixture.</Output>
  ```
  </Let>
  {reply}
  ````
  </Let>
  <TempDir>
    <File path="behavior.md">{behavior}</File>
    <Terminal columns={72} rows={20}>
      <Each in={[1, 2]} let="launch">
        <XMD.Repl sidekick-agent="./behavior.md">
          <XMD.Repl.SidekickPrompt text="fixture witness" />
          <Terminal.WaitForText text="Answer from the selected fixture." />
          <XMD.Repl.SidekickStatus as="status" />
          <AssertEquals actual={status.canonical.length} expected={1} />
          <AssertEquals actual={status.canonical[0].completed.length} expected={2} />
        </XMD.Repl>
      </Each>
    </Terminal>
  </TempDir>
</Test>
