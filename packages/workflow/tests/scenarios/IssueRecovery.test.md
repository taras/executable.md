# Recovering an issue the tracker already holds

Two attempts of one run, staged before this document. The first was interrupted
after the tracker had accepted its issue and before it could journal anything
about it. The second inherits a tracker holding an issue and a history that
never mentions it.

<StagedAttempt index={0} as="interrupted" />
<StagedAttempt index={1} as="recovered" />

## What the interruption left

<Test name="the interrupted attempt failed and journaled nothing about its effect">
<AssertEquals actual={interrupted.ok} expected={false} />
<AssertEquals actual={interrupted.effects} expected={0} />
</Test>

## What the second attempt did about it

The issue was already there, so recovering means adopting it rather than filing
a second one. The tracker's own state is the evidence: two attempts, one issue.

<Test name="the second attempt succeeded">
<AssertEquals actual={recovered.error} expected="" />
<AssertEquals actual={recovered.ok} expected={true} />
</Test>

The sequence the tracker saw says which of the two happened. An observation,
then a create, then a second observation — and no second create. That is the
whole recovery contract in one assertion: the second attempt looked before it
would have created, found what the first had left, and stopped there.

<Test name="two attempts, one create, and an observation before each">
<ServerRequests as="sent" />
<AssertEquals actual={sent.methods} expected={["GET", "POST", "GET"]} />
<AssertEquals actual={sent.markers} expected={1} />
<AssertEquals actual={sent.credentialed} expected={true} />
</Test>

Adoption is what the sequence shows; a *stable key* is what makes it possible.
Both attempts asked the boundary the same question, and the marker the second
one looked for is the digest of that key — so if the two keys differed, the
second attempt would have looked for a marker no issue carried and created
another one.

<Test name="both attempts carried one idempotency key">
<ProviderLog as="providers" />
<AssertEquals actual={providers.keys.length} expected={2} />
<AssertEquals actual={providers.keys[0]} expected={providers.keys[1]} />
</Test>

<Test name="two attempts left one issue">
<TrackerIssues as="tracker" />
<AssertEquals actual={tracker.count} expected={1} />
<AssertEquals actual={tracker.titles} expected={["Retry the publish step"]} />
</Test>
