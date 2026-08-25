# Filing an issue twice

Two attempts of one run, staged before this document, from the one checked-in
attempt document. The first files an issue. The second is a replay: the same
run, the same document, the same request.

<StagedAttempt index={0} as="first" />
<StagedAttempt index={1} as="second" />

## The first attempt files it

<Test name="the first attempt filed an issue and journaled that it had">
<AssertEquals actual={first.ok} expected={true} />
<AssertEquals actual={first.effects} expected={1} />
<AssertGreater actual={first.calls} expected={0} />
</Test>

## The second attempt asks nobody

The replay answers from what the run retained. The evidence is the tracker's
own request log rather than a claim about the boundary: a replay that had asked
would have left a request behind, and it left none. What makes that worth
saying is the assertion above it: the first attempt *did* leave requests behind,
so "none" here is a difference between the two attempts rather than a scenario
in which nobody ever calls anything.

<Test name="the replay reached no tracker at all">
<AssertEquals actual={second.ok} expected={true} />
<AssertEquals actual={second.calls} expected={0} />
</Test>

<Test name="the replay bound what the first attempt bound">
<AssertEquals actual={second.output} expected={first.output} />
</Test>

## And the tracker holds one issue, not two

<Test name="two attempts left one issue">
<TrackerIssues as="tracker" />
<AssertEquals actual={tracker.count} expected={1} />
<AssertEquals actual={tracker.titles} expected={["Retry the publish step"]} />
</Test>

## What the run retained

An upsert retains the normalized request, a reference — a URL — and where this
document wrote its `<Issue>`, and nothing else. The marker in particular is not
in it: the tracker carries the marker, so that an interrupted attempt can be
recognized by the next one, and the run carries the key it is a digest of.
Retaining the marker as well would put a run's internal identity into the
document that asked the question. The authored position is the run's own
document naming its own element — diagnostic data like `import_component`'s
retained paths, never the provider's or the deployment's.

<Test name="the retained upsert holds nothing private to the provider or the host">
<IssueJournal as="journal" />
<AssertEquals actual={journal.effects} expected={1} />
<AssertEquals actual={journal.retains.credential} expected={false} />
<AssertEquals actual={journal.retains.endpoint} expected={false} />
<AssertEquals actual={journal.retains.payload} expected={false} />
<AssertEquals actual={journal.retains.marker} expected={false} />
<AssertEquals actual={journal.retains.providerId} expected={false} />
<AssertEquals actual={journal.retains.hostPath} expected={false} />
</Test>
