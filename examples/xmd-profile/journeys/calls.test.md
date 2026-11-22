<Test name="calls mode counts function calls and holds one count capture at a time" timeout="60s">
  <TempDir>
    <Profile label="each" dir="captures" mode="calls" as="capture">
      <Each in={[1, 2, 3, 4, 5, 6, 7, 8]} let="n">
        <Json value={n} />
      </Each>
    </Profile>
    <AssertEquals actual={capture.mode} expected="calls" />
    <AssertEquals actual={capture.calls} expected="captures/each.calls.json" />
    <AssertGreater actual={capture.totalCalls} expected={0} />
    <Profile.Report path={capture.calls} as="report" />
    <AssertEquals actual={report.total} expected={capture.totalCalls} />
    <Profile.Start label="first" dir="captures" mode="calls" />
    <AssertThrows message={/call-count capture is already open/}>
      <Profile.Start label="second" dir="captures" mode="calls" />
    </AssertThrows>
    <Profile.Stop label="first" as="stopped" />
    <AssertGreater actual={stopped.totalCalls} expected={0} />
  </TempDir>
</Test>