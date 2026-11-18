<Cwd as="checkout" />
<Let as="fixtureRoot" value={checkout + "/examples/repl-bench/fixtures"} />

<Test name="#931 a Sidekick exchange groups three real turns and lets the reader inspect them" timeout="75s">
  <Terminal columns={160} rows={36}>
    <XMD.Repl scenario={fixtureRoot + "/repl-ui-conversation.md"} waitTimeout="20s" expectExit={true} as="closed">
      <Repl.Focus.Message />
      <Terminal.Type text="Review checkout." />
      <Terminal.Key key="Enter" />
      <Terminal.WaitForText text="Checkout review complete." />
      <XMD.Repl.EntryOutput entry={1} as="entry" />
      <AssertEquals actual={entry.status} expected="completed" />
      <AssertStringIncludes actual={entry.text} expected="Checkout output witness." />
      <Terminal.Region name="transcript">
        <Terminal.WaitForText text="[U] Review checkout." />
        <Terminal.WaitForText text="[S] Checkout review complete." count={1} />
        <Terminal.WaitForText text="[X] Round 1 result sent" as="feedback" />
      </Terminal.Region>
      <Terminal.Screenshot name="finished-exchange" />

      <Terminal.Click at={feedback} />
      <Terminal.WaitForText text="Show recorded feedback" />
      <Terminal.Click at={feedback} />
      <Terminal.WaitForText text="Show recorded feedback" present={false} />
      <Terminal.Click at={feedback} />
      <Terminal.WaitForText text="Show recorded feedback" />
      <Terminal.Key key="Enter" />
      <Terminal.WaitForText text="Entry entry-1 completed." />
      <Terminal.WaitForText text="Hide recorded feedback" />
      <Terminal.Screenshot name="recorded-feedback" />
      <Terminal.Key key="Escape" />
      <Terminal.WaitForText text="Hide recorded feedback" present={false} />

      <Terminal.Region name="transcript">
        <Terminal.WaitForText text="[S] Checkout review complete." as="reply" />
      </Terminal.Region>
      <Terminal.Click at={reply} />
      <Terminal.WaitForText text="linked entry Round 1" as="wholeLink" />
      <Terminal.WaitForText text="Checkout review complete." row={wholeLink.row + 2} as="shownOutput" />
      <Terminal.WaitForText text="SAVED TURNS" as="savedHeading" />
      <AssertEquals actual={Math.sign(savedHeading.row - shownOutput.row)} expected={1} />
      <Terminal.Screenshot name="exchange-with-output" />
      <Terminal.Click at={wholeLink} />
      <Terminal.WaitForText text="SAVED TURNS" present={false} />
      <Terminal.WaitForText text="Entries › Entry 1" />
      <Terminal.Click at={reply} />
      <Terminal.WaitForText text="Turn 2" as="savedTurn" />
      <Terminal.Click at={savedTurn} />
      <Terminal.WaitForText text="saved turn 2 of 3" />
      <Terminal.WaitForText text="Turn 2 · this turn · prompted by [X]" as="currentTurn" />
      <Terminal.WaitForText text="REPL.Environment result" row={currentTurn.row + 1} />
      <Terminal.WaitForText text="linked entry Round 1" />
      <Terminal.Screenshot name="saved-turn-2" />
      <Terminal.WaitForText text="· draft" present={false} />
      <Repl.Focus.Draft />
      <Terminal.Key key="Enter" />
      <Terminal.WaitForText text="saved turn 2 of 3" present={false} />
      <Terminal.WaitForText text="· draft" />
      <Terminal.Type text="visible-draft-witness" />
      <Terminal.WaitForText text="visible-draft-witness" />

      <Terminal.Resize columns={120} rows={30} />
      <Terminal.WaitForText text="HISTORY" row={29} />
      <Terminal.WaitForText text="[S] Checkout review complete." as="mediumReply" />
      <Terminal.Click at={mediumReply} />
      <Terminal.WaitForText text="Turn 2 · prompted by [X]" as="mediumTurn" />
      <Terminal.WaitForText text="REPL.Environment result" row={mediumTurn.row + 1} />
      <Terminal.Screenshot name="wrapped-turns" />
      <Terminal.Click at={mediumTurn} />
      <Terminal.WaitForText text="saved turn 2 of 3" />
      <Terminal.WaitForText text="Turn 2 · this turn" />
      <Terminal.WaitForText text="linked entry Round 1" as="savedLink" />
      <Terminal.Click at={savedLink} />
      <Terminal.WaitForText text="saved turn 2 of 3" present={false} />
      <Terminal.WaitForText text="Entries › Entry 1" />

      <Terminal.Resize columns={72} rows={20} />
      <Terminal.WaitForText text="HISTORY" row={19} />
      <Repl.Focus.Message />
      <Terminal.WaitForText text="↳ [X] Round 1 result sent" as="narrowFeedback" />
      <Terminal.Click at={narrowFeedback} />
      <Terminal.WaitForText text="Show recorded feedback" />
      <Terminal.WaitForText text="Outcome · ✓ COMPLETED" as="narrowOutcome" />
      <Terminal.WaitForText text="Output · Checkout output witness." />
      <Terminal.WaitForText text="Esc closes" as="narrowGuidance" />
      <Terminal.WaitForText text="PageUp/PageDown reads more content." />
      <AssertEquals actual={Math.sign(narrowOutcome.row - narrowGuidance.row)} expected={1} />
      <Terminal.WaitForText text="Entry entry-1 completed." present={false} />
      <Terminal.Screenshot name="narrow-feedback-drawer" />
      <Terminal.WaitForText text="> Show recorded feedback" />
      <Terminal.WaitForText text="linked entry Round 1" as="linked" />
      <Terminal.Click at={linked} />
      <Terminal.WaitForText text="* Entries" row={1} />
      <Terminal.WaitForText text="Show recorded feedback" present={false} />
      <Terminal.Resize columns={160} rows={36} />
      <Terminal.WaitForText text="[exit]" row={35} as="exit" />
      <Terminal.Click at={exit} />
    </XMD.Repl>
    <AssertEquals actual={closed.exitCode} expected={0} />
    <XMD.Repl resume={closed.resume}>
      <Terminal.Region name="transcript">
        <Terminal.WaitForText text="[S] Checkout review complete." count={1} />
      </Terminal.Region>
      <Terminal.WaitForText text="1 ✓" />
      <Terminal.WaitForText text="2 ✓" present={false} />
      <Terminal.Region name="transcript">
        <Terminal.WaitForText text="[X] Round 1 result sent" as="reopenedFeedback" />
      </Terminal.Region>
      <Terminal.Click at={reopenedFeedback} />
      <Terminal.WaitForText text="Show recorded feedback" />
      <Terminal.Key key="Enter" />
      <Terminal.WaitForText text="Entry entry-1 completed." />
    </XMD.Repl>
  </Terminal>
</Test>
