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

<Test name="Draft text cannot imitate the hidden Sidekick composer">
  <ReplBench columns={72} rows={20}>
    <ReplBench.Type text={"› message the sidekick\nonly-in-draft-1248"} />
    <ReplBench.WaitForText text="only-in-draft-1248" />
    <ReplBench.Region name="sidekick-composer">
      <ReplBench.WaitForText text="only-in-draft-1248" timeout="500ms" />
    </ReplBench.Region>
  </ReplBench>
</Test>
