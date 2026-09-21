# A retry the tracker never answered

One request, one run. The first attempt filed the issue and its process ended
before it could record that. The retry's transport does not answer at all.

Unknown is not absent. A retry that read silence as "no issue here" would file a
second one.

<StagedAttempt index={0} as="interrupted" />
<StagedAttempt index={1} as="retried" />

<Test name="the interruption left an issue and no record of it">
<AssertEquals actual={interrupted.ok} expected={false} />
<AssertEquals actual={interrupted.effects} expected={0} />
</Test>

<Test name="the retry refused because it could not tell">
<AssertEquals actual={retried.ok} expected={false} />
<AssertStringIncludes actual={retried.error} expected="temporarily unavailable" />
</Test>

<Test name="the retry reached the tracker not at all, and created nothing">
<AssertEquals actual={retried.calls} expected={0} />
<TrackerIssues as="tracker" />
<AssertEquals actual={tracker.count} expected={1} />
<ServerRequests as="sent" />
<AssertEquals actual={sent.markers} expected={1} />
</Test>
