<Test name="a timed-out test releases its terminal" timeout="8s">
  <ReplBench>
    <ReplBench.Focus target="sidekick-composer" />
    <ReplBench.Type text="keep-on-timeout" />
    <ReplBench.Region name="sidekick-composer">
      <ReplBench.WaitForText text="keep-on-timeout" />
      <ReplBench.WaitForText text="missing-on-purpose" timeout="2min" />
    </ReplBench.Region>
  </ReplBench>
</Test>
