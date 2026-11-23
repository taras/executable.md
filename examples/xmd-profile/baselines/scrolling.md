<Test name="wheel scrolling stays at its baseline calls" timeout="1800s">
  <Terminal columns={200} rows={52}>
    <XMD.Repl mounted={true} history={{rounds: 2, linesPerRound: 32}}>
      <Terminal.Scroll at={{row: 10, column: 60}} pattern="d." />
      <Terminal.WaitForText text="TAIL-BEGIN-000" count={1} />
      <Profile label="baseline-scrolling-reading-sparse" mode="calls" as="capture0">
        <Terminal.Scroll at={{row: 10, column: 60}} pattern="ddd.uuu.ddd.uuu.ddd.uuu.ddd.uuu.ddd.uuu." />
      </Profile>
    </XMD.Repl>
  </Terminal>
  <Terminal columns={200} rows={52}>
    <XMD.Repl mounted={true} history={{rounds: 12, linesPerRound: 32}}>
      <Terminal.Scroll at={{row: 10, column: 60}} pattern="d." />
      <Terminal.WaitForText text="TAIL-BEGIN-000" count={1} />
      <Profile label="baseline-scrolling-reading-full" mode="calls" as="capture1">
        <Terminal.Scroll at={{row: 10, column: 60}} pattern="ddd.uuu.ddd.uuu.ddd.uuu.ddd.uuu.ddd.uuu." />
      </Profile>
    </XMD.Repl>
  </Terminal>
  <Terminal columns={200} rows={52}>
    <XMD.Repl mounted={true} history={{rounds: 12, linesPerRound: 32}}>
      <Terminal.Scroll at={{row: 10, column: 60}} pattern="d." />
      <Terminal.WaitForText text="TAIL-BEGIN-000" count={1} />
      <Profile label="baseline-scrolling-reading-full-spaced" mode="calls" as="capture2">
        <Terminal.Scroll at={{row: 10, column: 60}} pattern="d.d.d.u.u.u.d.d.d.u.u.u.d.d.d.u.u.u.d.d.d.u.u.u.d.d.d.u.u.u." />
      </Profile>
    </XMD.Repl>
  </Terminal>
  <Terminal columns={200} rows={52}>
    <XMD.Repl mounted={true} history={{rounds: 52, linesPerRound: 32}}>
      <Terminal.Scroll at={{row: 10, column: 60}} pattern="d." />
      <Terminal.WaitForText text="TAIL-BEGIN-000" count={1} />
      <Profile label="baseline-scrolling-reading-long-history" mode="calls" as="capture3">
        <Terminal.Scroll at={{row: 10, column: 60}} pattern="ddd.uuu.ddd.uuu.ddd.uuu.ddd.uuu.ddd.uuu." />
      </Profile>
    </XMD.Repl>
  </Terminal>
  <Terminal columns={200} rows={52}>
    <XMD.Repl mounted={true} history={{rounds: 12, linesPerRound: 368}}>
      <Terminal.Scroll at={{row: 10, column: 60}} pattern="d." />
      <Terminal.WaitForText text="TAIL-BEGIN-000" count={0} />
      <Profile label="baseline-scrolling-reading-long-entry" mode="calls" as="capture4">
        <Terminal.Scroll at={{row: 10, column: 60}} pattern="ddd.uuu.ddd.uuu.ddd.uuu.ddd.uuu.ddd.uuu." />
      </Profile>
    </XMD.Repl>
  </Terminal>
  <Profile.Baseline path="examples/xmd-profile/baselines/scrolling-reading-sparse.baseline.md"
    title="Thirty wheel notches in the entry reading, bursts of three, 2 rounds of 32 lines"
    captures={[{calls: capture0.calls}]} />
  <Profile.Baseline path="examples/xmd-profile/baselines/scrolling-reading-full.baseline.md"
    title="Thirty wheel notches in the entry reading, bursts of three, 12 rounds of 32 lines"
    captures={[{calls: capture1.calls}]} />
  <Profile.Baseline path="examples/xmd-profile/baselines/scrolling-reading-full-spaced.baseline.md"
    title="Thirty wheel notches in the entry reading, spaced, 12 rounds of 32 lines"
    captures={[{calls: capture2.calls}]} />
  <Profile.Baseline path="examples/xmd-profile/baselines/scrolling-reading-long-history.baseline.md"
    title="Thirty wheel notches in the entry reading, bursts of three, 52 rounds of 32 lines"
    captures={[{calls: capture3.calls}]} />
  <Profile.Baseline path="examples/xmd-profile/baselines/scrolling-reading-long-entry.baseline.md"
    title="Thirty wheel notches in the entry reading, bursts of three, 12 rounds of 368 lines"
    captures={[{calls: capture4.calls}]} />
</Test>
