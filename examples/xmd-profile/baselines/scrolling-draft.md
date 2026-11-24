<Test name="draft caret movement stays at its baseline calls" timeout="1800s">
  <Terminal columns={200} rows={52}>
    <XMD.Repl mounted={true} history={{rounds: 12, linesPerRound: 32}} draft={{lines: 120}}>
      <Each in={["Up", "Up", "Up"]} let="key">
        <Terminal.Key key={key} />
        <Terminal.Scroll pattern="." />
      </Each>
      <Terminal.Type text="§" />
      <Terminal.WaitForText text="DRAFT-LINE-116 verified words ..................................§" />
      <Terminal.Key key="Backspace" />
      <Terminal.WaitForText text="§" present={false} />
      <Terminal.WaitForText text="DRAFT-END-119" present={true} />
      <Profile label="baseline-scrolling-draft-caret-still" mode="calls" as="capture0">
        <Each in={["Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Down", "Down", "Down", "Down", "Down", "Down", "Down", "Down", "Down", "Down", "Down", "Down", "Down", "Down", "Down"]} let="key">
          <Terminal.Key key={key} />
          <Terminal.Scroll pattern="." />
        </Each>
      </Profile>
    </XMD.Repl>
  </Terminal>
  <Profile.Baseline path="examples/xmd-profile/baselines/scrolling-draft-caret-still.baseline.md"
    title="Thirty arrow keys in the draft, window initially still, 120 lines"
    captures={[{calls: capture0.calls}]} />
  <Terminal columns={200} rows={52}>
    <XMD.Repl mounted={true} history={{rounds: 12, linesPerRound: 32}} draft={{lines: 120}}>
      <Each in={["Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up"]} let="key">
        <Terminal.Key key={key} />
        <Terminal.Scroll pattern="." />
      </Each>
      <Terminal.WaitForText text="DRAFT-END-119" present={false} />
      <Profile label="baseline-scrolling-draft-caret-moving" mode="calls" as="capture1">
        <Each in={["Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Down", "Down", "Down", "Down", "Down", "Down", "Down", "Down", "Down", "Down", "Down", "Down", "Down", "Down", "Down"]} let="key">
          <Terminal.Key key={key} />
          <Terminal.Scroll pattern="." />
        </Each>
      </Profile>
    </XMD.Repl>
  </Terminal>
  <Profile.Baseline path="examples/xmd-profile/baselines/scrolling-draft-caret-moving.baseline.md"
    title="Thirty arrow keys in the draft, window moved by warm-up, 120 lines"
    captures={[{calls: capture1.calls}]} />
  <Terminal columns={200} rows={52}>
    <XMD.Repl mounted={true} history={{rounds: 12, linesPerRound: 32}} draft={{lines: 368}}>
      <Each in={["Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up"]} let="key">
        <Terminal.Key key={key} />
        <Terminal.Scroll pattern="." />
      </Each>
      <Terminal.WaitForText text="DRAFT-END-367" present={false} />
      <Profile label="baseline-scrolling-draft-caret-moving-long" mode="calls" as="capture2">
        <Each in={["Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Up", "Down", "Down", "Down", "Down", "Down", "Down", "Down", "Down", "Down", "Down", "Down", "Down", "Down", "Down", "Down"]} let="key">
          <Terminal.Key key={key} />
          <Terminal.Scroll pattern="." />
        </Each>
      </Profile>
    </XMD.Repl>
  </Terminal>
  <Profile.Baseline path="examples/xmd-profile/baselines/scrolling-draft-caret-moving-long.baseline.md"
    title="Thirty arrow keys in the draft, window moved by warm-up, 368 lines"
    captures={[{calls: capture2.calls}]} />
</Test>

<Test name="draft-wheel" timeout="1800s">
  <Terminal columns={200} rows={52}>
    <XMD.Repl mounted={true} history={{rounds: 12, linesPerRound: 32}} draft={{lines: 120}}>
      <Terminal.Scroll at={{row: 10, column: 60}} pattern="u." />
      <Terminal.WaitForText text="DRAFT-LINE-072" />
      <Profile label="draft-wheel" mode="calls" as="draftWheel">
        <Terminal.Scroll at={{row: 10, column: 60}} pattern="uuu.ddd.uuu.ddd.uuu.ddd.uuu.ddd.uuu.ddd." />
      </Profile>
    </XMD.Repl>
  </Terminal>
  <Profile.Baseline path="examples/xmd-profile/baselines/scrolling-draft-wheel.baseline.md"
    title="Draft wheel bursts, 120 lines" captures={[{calls: draftWheel.calls}]} />
</Test>
