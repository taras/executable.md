<Test name="a timed-out test releases its terminal" timeout="8s">
  <ReplBench waitTimeout="2min">
    <ReplBench.Focus target="sidekick-composer" />
    <ReplBench.Type text="keep-on-timeout" />
    <ReplBench.Region name="sidekick-composer">
      <ReplBench.WaitForText text="keep-on-timeout" />
      <ReplBench.WaitForText text="missing-on-purpose" />
    </ReplBench.Region>
  </ReplBench>
</Test>

<Test name="Draft text cannot imitate the hidden Sidekick composer">
  <ReplBench columns={72} rows={20} waitTimeout="2min">
    <ReplBench.Type text={"› message the sidekick\nonly-in-draft-1248"} />
    <ReplBench.WaitForText text="only-in-draft-1248" />
    <ReplBench.Region name="sidekick-composer">
      <ReplBench.WaitForText text="only-in-draft-1248" timeout="500ms" />
    </ReplBench.Region>
  </ReplBench>
</Test>


<Test name="a scripted Sidekick mismatch fails the exact prompt step" timeout="60s">
  <ReplBench scenario="scripts/tests/fixtures/repl-scripted-sidekick.md">
    <ReplBench.SidekickPrompt text="Unexpected prompt." />
  </ReplBench>
</Test>


<Test name="a failed test closes the REPL during an active ACP prompt" timeout="60s">
  <ReplBench scenario="scripts/tests/fixtures/repl-sidekick-ordered-reads.md">
    <ReplBench.SidekickPrompt text="What should I know?" />
    <ReplBench.Focus target="sidekick-composer" />
    <All>
      <Spawn>
        <ReplBench.SidekickPrompt text="Ask the human." />
      </Spawn>
      <Spawn>
        <ReplBench.WaitForText text="[answer sidekick]" />
        <ReplBench.WaitForText text="fail-with-a-pending-acp-question" timeout="3s" />
      </Spawn>
    </All>
  </ReplBench>
</Test>


<Test name="Draft text cannot imitate the History drawer">
  <ReplBench columns={72} rows={20}>
    <ReplBench.Type text={"────────────────────────\n History \nfalse-history-drawer"} />
    <ReplBench.WaitForText text="false-history-drawer" />
    <ReplBench.Region name="history">
      <ReplBench.WaitForText text="false-history-drawer" timeout="500ms" />
    </ReplBench.Region>
  </ReplBench>
</Test>
