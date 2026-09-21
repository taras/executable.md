# A retry that found its issue closed

One request, one run. The first attempt filed the issue and its process ended
before it could record that. Between the attempts somebody closed it.

A closed issue carrying this key's marker is not absence, and it is not
something to reopen. Somebody decided this was done, and a retry does not
overrule them by filing it again.

<StagedAttempt index={0} as="interrupted" />
<StagedAttempt index={1} as="retried" />

<Test name="the interruption left an issue and no record of it">
<AssertEquals actual={interrupted.ok} expected={false} />
<AssertEquals actual={interrupted.effects} expected={0} />
</Test>

<Test name="the retry refused rather than reopening it">
<AssertEquals actual={retried.ok} expected={false} />
<AssertStringIncludes actual={retried.error} expected="conflicts with" />
</Test>

<Test name="the retry read once, created nothing, and left it closed">
<AssertEquals actual={retried.calls} expected={1} />
<TrackerIssues as="tracker" />
<AssertEquals actual={tracker.count} expected={1} />
<AssertEquals actual={tracker.states} expected={["closed"]} />
<ServerRequests as="sent" />
<AssertEquals actual={sent.markers} expected={1} />
</Test>
