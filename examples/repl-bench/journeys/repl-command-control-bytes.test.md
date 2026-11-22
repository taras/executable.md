<Test name="both entry readings display captured control bytes as text" timeout="60s">
  <ReplBench scenario="examples/repl-bench/fixtures/repl-sidekick-command-output.md" columns={160} rows={44} waitTimeout="30s">
    <ReplBench.Focus target="sidekick-composer" />
    <ReplBench.Type text="Run the probe." />
    <ReplBench.Region name="sidekick-composer">
      <ReplBench.WaitForText text="Run the probe." />
    </ReplBench.Region>
    <ReplBench.Key key="Enter" />
    <ReplBench.WaitForText text="1 ✓" />
    <ReplBench.WaitForText text="Probe completed." />
    <ReplBench.WaitForText text="[stop]" present={false} />
    <ReplBench.WaitForText text="[ ] Show token usage" row={0} as="usage" />
    <ReplBench.Click at={usage} />
    <ReplBench.WaitForText text="│  Output" as="output" />
    <ReplBench.WaitForText text="Entry agents · No retained entry-agent turns" as="associated" />
    <ReplBench.WaitForText text={"PROBE\\x1b[2JTAIL\\x0dEND"} row={output.row+1} as="entryText" />
    <ReplBench.WaitForText text={"PROBE\\x1b[2JTAIL\\x0dEND"} row={associated.row+1} as="associatedText" />
    <AssertEquals actual={entryText.column === output.column+3} expected={true} />
    <AssertEquals actual={associatedText.column >= associated.column} expected={true} />
    <ReplBench.WaitForText text={"PROBE\\x1b[2JTAIL\\x0dEND"} count={2} />
    <ReplBench.WaitForText text="�" present={false} />
  </ReplBench>
</Test>
