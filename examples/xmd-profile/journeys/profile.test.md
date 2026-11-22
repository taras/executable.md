<Test name="Profile writes the CPU profile of the content it wraps" timeout="60s">
  <TempDir>
    <Profile label="each" dir="captures" as="capture">
      <Each in={[1, 2, 3, 4, 5, 6, 7, 8]} let="n">
        <Json value={n} />
      </Each>
    </Profile>
    <AssertEquals actual={capture.label} expected="each" />
    <AssertEquals actual={capture.profile} expected="captures/each.cpuprofile" />
    <AssertGreater actual={capture.samples} expected={0} />
    <Profile.Report path={capture.profile} as="report" />
    <AssertEquals actual={report.samples} expected={capture.samples} />
    <AssertGreater actual={report.activeUs} expected={0} />
    <Profile.Compare baseline={capture.profile} candidate={capture.profile} as="same" />
    <AssertEquals actual={same.active.deltaUs} expected={0} />
  </TempDir>
</Test>

<Test name="Profile keeps the capture when its content fails" timeout="60s">
  <TempDir>
    <AssertThrows message={/missing\.txt/}>
      <Profile label="failing" dir="captures">
        <File path="missing.txt" />
      </Profile>
    </AssertThrows>
    <File path="captures/failing.json" as="receipt" />
    <AssertStringIncludes actual={receipt} expected="captures/failing.cpuprofile" />
  </TempDir>
</Test>