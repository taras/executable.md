# A retry that found its issue in another repository

One request, one run. The first attempt filed the issue and its process ended
before it could record that. Between the attempts the issue turned up somewhere
else, still carrying this key's marker.

This key's own marker in a repository this request never named is not absence,
and it is not something to overwrite where it now sits.

<StagedAttempt index={0} as="interrupted" />
<StagedAttempt index={1} as="retried" />

<Test name="the interruption left an issue and no record of it">
<AssertEquals actual={interrupted.ok} expected={false} />
<AssertEquals actual={interrupted.effects} expected={0} />
</Test>

<Test name="the retry refused rather than adopting it where it moved to">
<AssertEquals actual={retried.ok} expected={false} />
<AssertStringIncludes actual={retried.error} expected="conflicts with" />
</Test>

<Test name="the retry read once, created nothing, and left it where it moved to">
<AssertEquals actual={retried.calls} expected={1} />
<TrackerIssues as="tracker" />
<AssertEquals actual={tracker.count} expected={1} />
<AssertEquals
  actual={tracker.repositories}
  expected={["https://api.github.com/repos/octo/moved"]}
/>
<AssertEquals actual={tracker.states} expected={["open"]} />
<ServerRequests as="sent" />
<AssertEquals actual={sent.markers} expected={1} />
</Test>
