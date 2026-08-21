# A retry that found two issues carrying one marker

One request, one run. The first attempt filed the issue and its process ended
before it could record that. Between the attempts a second issue turned up
carrying the same marker.

Two issues carrying one key's marker is a state the request cannot name. Adopting
either would be picking one arbitrarily, and filing again would make three.

<StagedAttempt index={0} as="interrupted" />
<StagedAttempt index={1} as="retried" />

<Test name="the interruption left an issue and no record of it">
<AssertEquals actual={interrupted.ok} expected={false} />
<AssertEquals actual={interrupted.effects} expected={0} />
</Test>

<Test name="the retry refused rather than adopting one of them">
<AssertEquals actual={retried.ok} expected={false} />
<AssertStringIncludes
  actual={retried.error}
  expected="cannot prove whether this issue already exists"
/>
</Test>

<Test name="the retry read once and created nothing">
<AssertEquals actual={retried.calls} expected={1} />
<TrackerIssues as="tracker" />
<AssertEquals actual={tracker.count} expected={2} />
<ServerRequests as="sent" />
<AssertEquals actual={sent.markers} expected={1} />
</Test>
