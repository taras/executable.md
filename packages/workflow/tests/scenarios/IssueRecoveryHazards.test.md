# What a retry does when the tracker is not where it was left

Four requests of one run, each interrupted after the tracker accepted its issue,
each retried against a tracker that has since moved underneath it.

The claim is the same for all four, and it is the one that matters: **none of
these states is absence.** A retry that read any of them as "no issue here" would
create a second one, and the run would have filed twice for a question it asked
once.

<StagedAttempt index={0} as="interrupted" />
<StagedAttempt index={1} as="retried" />

## The interruption left four issues and no record of them

<Test name="the first attempt filed four issues and journaled none">
<AssertEquals actual={interrupted.effects} expected={0} />
<TrackerIssues as="tracker" />
<AssertGreater actual={tracker.count} expected={3} />
</Test>

## Each retry refused, and each refusal named its own state

A transport that will not answer leaves this request's state unknown. Unknown is
not absent.

<Test name="an unanswered transport is unavailable, not absent">
<AssertStringIncludes actual={retried.output} expected="temporarily unavailable" />
</Test>

Two issues carrying one key's marker is a state the request cannot name. Adopting
either would be picking one arbitrarily.

<Test name="two issues carrying one marker is ambiguous, not absent">
<AssertStringIncludes actual={retried.output} expected="cannot prove whether this issue already exists" />
</Test>

This key's own marker on an issue in another repository, and on one somebody has
closed: neither is absence, and neither is something to reopen or overwrite.

<Test name="a moved or closed issue conflicts, and is not reopened or overwritten">
<AssertStringIncludes actual={retried.output} expected="conflicts with" />
</Test>

## And none of them created anything

The whole point, stated as tracker arithmetic. Four issues were filed by the
first attempt and one duplicate was planted between the attempts, so five is
what a tracker holds if no retry created anything.

<Test name="four refusals created nothing">
<TrackerIssues as="tracker" />
<AssertEquals actual={tracker.count} expected={5} />
</Test>

And as request arithmetic. The retry made three requests: the unanswered one
never reached the tracker at all, and each of the other three read it once and
then refused. A create would have been a fourth.

<Test name="the retry read three times and created nothing">
<AssertEquals actual={retried.calls} expected={3} />
</Test>

Only the first attempt's four creates ever carried a marker. A retry that had
written one would have been a retry that created.

<Test name="no retry wrote a marker">
<ServerRequests as="sent" />
<AssertEquals actual={sent.markers} expected={4} />
</Test>
