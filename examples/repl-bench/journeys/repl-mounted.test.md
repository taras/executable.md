<Test name="a mounted REPL answers terminal components without a child process" timeout="120s">
  <Terminal columns={200} rows={52}>
    <XMD.Repl mounted={true} history={{rounds: 2, linesPerRound: 32}}>
      <Terminal.Focus target="sidekick-composer" />
      <Terminal.Type text="mounted-marker" />
      <Terminal.Region name="sidekick-composer">
        <Terminal.WaitForText text="mounted-marker" as="found" />
      </Terminal.Region>
      <AssertGreaterOrEqual actual={found.row} expected={0} />
      <XMD.Repl.Revision as="revision" />
      <AssertEquals actual={revision} expected={null} />
      <Let as="outcome">
        <Try>
          <Terminal.Screenshot name="unanswered" />
          answered
          <Catch>refused</Catch>
        </Try>
      </Let>
      <AssertStringIncludes actual={outcome} expected="refused" />
      <AssertNotMatch actual={outcome} expected={/answered/} />
      <Terminal.Type text="-after" />
      <Terminal.Region name="sidekick-composer">
        <Terminal.WaitForText text="mounted-marker-after" />
      </Terminal.Region>
    </XMD.Repl>
  </Terminal>
</Test>