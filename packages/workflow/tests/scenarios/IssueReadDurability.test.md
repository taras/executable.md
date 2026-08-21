# Reading the same issue twice

A read is a durable effect like any other. The second attempt of a run does not
ask again — it answers from what the first retained, and it binds the same
`IssueDetails` it bound the first time.

<StagedAttempt index={0} as="first" />
<StagedAttempt index={1} as="second" />

## The replay asks nobody

<Test name="the first attempt read the issue over the transport">
<AssertEquals actual={first.ok} expected={true} />
<AssertEquals actual={first.effects} expected={1} />
<AssertGreater actual={first.calls} expected={0} />
</Test>

The replay ran with the provider boundary refusing every call, so reaching a
provider at all would have failed it. It succeeded, and the tracker received
nothing — two independent statements of the same thing.

<Test name="the replay reached no provider and no tracker">
<AssertEquals actual={second.error} expected="" />
<AssertEquals actual={second.ok} expected={true} />
<AssertEquals actual={second.calls} expected={0} />
</Test>

## And it bound the same details

<Test name="the replay bound the details the first attempt bound">
<AssertStringIncludes actual={first.output} expected="Retry the publish step" />
<AssertEquals actual={second.output} expected={first.output} />
</Test>

## What the run retained

The retained Issue effect holds the normalized request and the normalized public
result, and none of the things a provider knows that a document must never hold.

This is a statement about what `<Issue>` wrote, not about the whole run. The
run's own `import_component` records carry the host path of every module it
loaded; that is the run's business, and no Issue effect either causes it or can
prevent it.

<Test name="the retained read holds nothing private to the provider or the host">
<IssueJournal as="journal" />
<AssertEquals actual={journal.effects} expected={1} />
<AssertEquals actual={journal.retains.credential} expected={false} />
<AssertEquals actual={journal.retains.endpoint} expected={false} />
<AssertEquals actual={journal.retains.payload} expected={false} />
<AssertEquals actual={journal.retains.marker} expected={false} />
<AssertEquals actual={journal.retains.providerId} expected={false} />
<AssertEquals actual={journal.retains.hostPath} expected={false} />
</Test>
