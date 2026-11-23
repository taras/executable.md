<Test name="Profile.Start and Profile.Stop capture the work between them" timeout="60s">
  <TempDir>
    <Profile.Start label="span" dir="captures" />
    <Each in={[1, 2, 3, 4, 5, 6, 7, 8]} let="n">
      <Json value={n} />
    </Each>
    <Profile.Stop label="span" as="capture" />
    <AssertEquals actual={capture.profile} expected="captures/span.cpuprofile" />
    <AssertGreater actual={capture.samples} expected={0} />
    <Profile.Report path={capture.profile} as="report" />
    <AssertEquals actual={report.samples} expected={capture.samples} />
    <AssertThrows message={/no open capture named span/}>
      <Profile.Stop label="span" />
    </AssertThrows>
  </TempDir>
</Test>

<Test name="Profile.Start refuses a label that is already open" timeout="60s">
  <TempDir>
    <Profile.Start label="twice" dir="captures" />
    <AssertThrows message={/already open/}>
      <Profile.Start label="twice" dir="captures" />
    </AssertThrows>
    <Profile.Stop label="twice" />
  </TempDir>
</Test>