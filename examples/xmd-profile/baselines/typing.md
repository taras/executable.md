<Test name="thirty keystrokes in the Sidekick composer stay at their baseline calls" timeout="900s">
  <Let as="warmup" value={[{type: "a", shows: "XMD:a"}, {type: "b", shows: "XMD:ab"}, {type: "c", shows: "XMD:abc"}, {type: "d", shows: "XMD:abcd"}, {type: "e", shows: "XMD:abcde"}, {type: "f", shows: "XMD:abcdef"}, {type: "g", shows: "XMD:abcdefg"}, {type: "h", shows: "XMD:abcdefgh"}, {type: "i", shows: "XMD:abcdefghi"}, {type: "j", shows: "XMD:abcdefghij"}]} />
  <Let as="measured" value={[{type: "k", shows: "XMD:abcdefghijk"}, {type: "l", shows: "XMD:abcdefghijkl"}, {type: "m", shows: "XMD:abcdefghijklm"}, {type: "n", shows: "XMD:abcdefghijklmn"}, {type: "o", shows: "XMD:abcdefghijklmno"}, {type: "p", shows: "XMD:abcdefghijklmnop"}, {type: "q", shows: "XMD:abcdefghijklmnopq"}, {type: "r", shows: "XMD:abcdefghijklmnopqr"}, {type: "s", shows: "XMD:abcdefghijklmnopqrs"}, {type: "t", shows: "XMD:abcdefghijklmnopqrst"}, {type: "u", shows: "XMD:abcdefghijklmnopqrstu"}, {type: "v", shows: "XMD:abcdefghijklmnopqrstuv"}, {type: "w", shows: "XMD:abcdefghijklmnopqrstuvw"}, {type: "x", shows: "XMD:abcdefghijklmnopqrstuvwx"}, {type: "y", shows: "XMD:abcdefghijklmnopqrstuvwxy"}, {type: "z", shows: "XMD:abcdefghijklmnopqrstuvwxyz"}, {type: "a", shows: "XMD:abcdefghijklmnopqrstuvwxyza"}, {type: "b", shows: "XMD:abcdefghijklmnopqrstuvwxyzab"}, {type: "c", shows: "XMD:abcdefghijklmnopqrstuvwxyzabc"}, {type: "d", shows: "XMD:abcdefghijklmnopqrstuvwxyzabcd"}, {type: "e", shows: "XMD:abcdefghijklmnopqrstuvwxyzabcde"}, {type: "f", shows: "XMD:abcdefghijklmnopqrstuvwxyzabcdef"}, {type: "g", shows: "XMD:abcdefghijklmnopqrstuvwxyzabcdefg"}, {type: "h", shows: "XMD:abcdefghijklmnopqrstuvwxyzabcdefgh"}, {type: "i", shows: "XMD:abcdefghijklmnopqrstuvwxyzabcdefghi"}, {type: "j", shows: "XMD:abcdefghijklmnopqrstuvwxyzabcdefghij"}, {type: "k", shows: "XMD:abcdefghijklmnopqrstuvwxyzabcdefghijk"}, {type: "l", shows: "XMD:abcdefghijklmnopqrstuvwxyzabcdefghijkl"}, {type: "m", shows: "XMD:abcdefghijklmnopqrstuvwxyzabcdefghijklm"}, {type: "n", shows: "XMD:abcdefghijklmnopqrstuvwxyzabcdefghijklmn"}]} />
  <Terminal columns={200} rows={52}>
    <XMD.Repl mounted={true} history={{rounds: 2, linesPerRound: 32}}>
      <Terminal.Focus target="sidekick-composer" />
      <Terminal.Type text="XMD:" />
      <Terminal.Region name="sidekick-composer">
        <Terminal.WaitForText text="XMD:" />
      </Terminal.Region>
      <Each in={warmup} let="edit">
        <Terminal.Type text={edit.type} />
        <Terminal.Region name="sidekick-composer">
          <Terminal.WaitForText text={edit.shows} />
        </Terminal.Region>
      </Each>
      <Profile label="baseline-typing-sparse" mode="calls" as="sparse">
        <Each in={measured} let="edit">
          <Terminal.Type text={edit.type} />
          <Terminal.Region name="sidekick-composer">
            <Terminal.WaitForText text={edit.shows} />
          </Terminal.Region>
        </Each>
      </Profile>
    </XMD.Repl>
  </Terminal>
  <Terminal columns={200} rows={52}>
    <XMD.Repl mounted={true} history={{rounds: 12, linesPerRound: 32}}>
      <Terminal.Focus target="sidekick-composer" />
      <Terminal.Type text="XMD:" />
      <Terminal.Region name="sidekick-composer">
        <Terminal.WaitForText text="XMD:" />
      </Terminal.Region>
      <Each in={warmup} let="edit">
        <Terminal.Type text={edit.type} />
        <Terminal.Region name="sidekick-composer">
          <Terminal.WaitForText text={edit.shows} />
        </Terminal.Region>
      </Each>
      <Profile label="baseline-typing-full" mode="calls" as="full">
        <Each in={measured} let="edit">
          <Terminal.Type text={edit.type} />
          <Terminal.Region name="sidekick-composer">
            <Terminal.WaitForText text={edit.shows} />
          </Terminal.Region>
        </Each>
      </Profile>
    </XMD.Repl>
  </Terminal>
  <Terminal columns={200} rows={52}>
    <XMD.Repl mounted={true} history={{rounds: 52, linesPerRound: 32}}>
      <Terminal.Focus target="sidekick-composer" />
      <Terminal.Type text="XMD:" />
      <Terminal.Region name="sidekick-composer">
        <Terminal.WaitForText text="XMD:" />
      </Terminal.Region>
      <Each in={warmup} let="edit">
        <Terminal.Type text={edit.type} />
        <Terminal.Region name="sidekick-composer">
          <Terminal.WaitForText text={edit.shows} />
        </Terminal.Region>
      </Each>
      <Profile label="baseline-typing-long-history" mode="calls" as="longHistory">
        <Each in={measured} let="edit">
          <Terminal.Type text={edit.type} />
          <Terminal.Region name="sidekick-composer">
            <Terminal.WaitForText text={edit.shows} />
          </Terminal.Region>
        </Each>
      </Profile>
    </XMD.Repl>
  </Terminal>
  <Terminal columns={200} rows={52}>
    <XMD.Repl mounted={true} history={{rounds: 12, linesPerRound: 368}}>
      <Terminal.Focus target="sidekick-composer" />
      <Terminal.Type text="XMD:" />
      <Terminal.Region name="sidekick-composer">
        <Terminal.WaitForText text="XMD:" />
      </Terminal.Region>
      <Each in={warmup} let="edit">
        <Terminal.Type text={edit.type} />
        <Terminal.Region name="sidekick-composer">
          <Terminal.WaitForText text={edit.shows} />
        </Terminal.Region>
      </Each>
      <Profile label="baseline-typing-long-entry" mode="calls" as="longEntry">
        <Each in={measured} let="edit">
          <Terminal.Type text={edit.type} />
          <Terminal.Region name="sidekick-composer">
            <Terminal.WaitForText text={edit.shows} />
          </Terminal.Region>
        </Each>
      </Profile>
    </XMD.Repl>
  </Terminal>
  <Profile.Baseline
    path="examples/xmd-profile/baselines/typing-sparse.baseline.md"
    title="Thirty keystrokes in the composer, sparse screen, 2 rounds of 32 lines"
    captures={[{calls: sparse.calls}]}
  />
  <Profile.Baseline
    path="examples/xmd-profile/baselines/typing-full.baseline.md"
    title="Thirty keystrokes in the composer, full screen, 12 rounds of 32 lines"
    captures={[{calls: full.calls}]}
  />
  <Profile.Baseline
    path="examples/xmd-profile/baselines/typing-long-history.baseline.md"
    title="Thirty keystrokes in the composer, long history, 52 rounds of 32 lines"
    captures={[{calls: longHistory.calls}]}
  />
  <Profile.Baseline
    path="examples/xmd-profile/baselines/typing-long-entry.baseline.md"
    title="Thirty keystrokes in the composer, long entry, 12 rounds of 368 lines"
    captures={[{calls: longEntry.calls}]}
  />
</Test>
