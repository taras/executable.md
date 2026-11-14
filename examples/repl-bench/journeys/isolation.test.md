<Test name="a failed terminal preserves its own captures and leaves the other terminal usable" timeout="60s">
  <Cwd as="checkout" />
  <Terminal columns={160} rows={36}>
    <XMD.Repl expectExit={true} as="survivor">
      <Terminal.Focus target="sidekick-composer" />
      <Terminal.Type text="bench-second;" />
      <Terminal.Region name="sidekick-composer">
        <Terminal.WaitForText text="bench-second;" />
      </Terminal.Region>
      <Terminal.Screenshot name="composer" as="secondImage" />
      <Let as="secondDirectory" value={secondImage.slice(0, secondImage.lastIndexOf("/"))} />
      <Try>
        <Terminal columns={160} rows={36}>
          <XMD.Repl>
            <Terminal.Focus target="sidekick-composer" />
            <Terminal.Type text="bench-first;" />
            <Terminal.Region name="sidekick-composer">
              <Terminal.WaitForText text="bench-first;" />
              <Terminal.WaitForText text="bench-second;" present={false} />
            </Terminal.Region>
            <Terminal.Screenshot name="composer" />
            <Terminal.WaitForText text="missing-on-purpose" timeout="500ms" />
          </XMD.Repl>
        </Terminal>
        <Fail message="The first terminal should have failed" />
        <Catch as="failure">
          <AssertStringIncludes actual={failure.message} expected={'Timed out waiting for "missing-on-purpose"'} />
          <Let as="firstDirectory" value={failure.message.match(/^Evidence: (.+)$/m)?.[1]} />
          <AssertExists actual={firstDirectory} />
          <AssertNotEquals actual={firstDirectory} expected={secondDirectory} />
          <Let as="path" value={firstDirectory.slice(checkout.length + 1)} />
          <File path={path + "/composer.svg"} as="firstSvg" />
          <File path={path + "/screen.txt"} as="firstScreen" />
          <File path={path + "/terminal.ansi"} as="firstAnsi" />
          <File path={path + "/closed.json"} as="firstClosed" />
          <AssertMatch actual={firstSvg} expected={/^<svg /} />
          <AssertStringIncludes actual={firstSvg} expected="bench-first;" />
          <AssertStringIncludes actual={firstScreen} expected="bench-first;" />
          <AssertFalse expr={firstSvg.includes("bench-second;") || firstScreen.includes("bench-second;")} />
          <AssertStringIncludes actual={firstAnsi} expected="bench-first;" />
          <AssertStringIncludes actual={firstClosed} expected={'"step":"wait"'} />
        </Catch>
      </Try>
      <File path={secondImage.slice(checkout.length + 1)} as="secondSvg" />
      <AssertMatch actual={secondSvg} expected={/^<svg /} />
      <AssertStringIncludes actual={secondSvg} expected="bench-second;" />
      <AssertFalse expr={secondSvg.includes("bench-first;")} />
      <Terminal.Type text="still-open;" />
      <Terminal.Region name="sidekick-composer">
        <Terminal.WaitForText text="bench-second;still-open;" />
        <Terminal.WaitForText text="bench-first;" present={false} />
        <Terminal.Key key="Ctrl+C" />
        <Terminal.WaitForText text="bench-second;" present={false} />
      </Terminal.Region>
      <Terminal.Key key="Ctrl+C" />
    </XMD.Repl>
    <AssertEquals actual={survivor.exitCode} expected={0} />
  </Terminal>
</Test>
