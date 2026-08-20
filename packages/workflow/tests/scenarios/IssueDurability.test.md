# Issue durability

What the journal holds decides what a second execution does. These scenarios run
a checked-in document more than once against one journal and assert on what the
run retained rather than on what a tracker happens to hold now.

## A replay reaches no provider

A completed request answers from the journal. Nothing is resolved, no credential
is read and no request is sent — proven by installing middleware that fails the
scenario if it is reached at all.

<Test name="A retained result returns without reaching any provider">
<IssueFixture />
<IssueAttempt document="one-issue.md" as="first" />
<AssertEquals actual={first.ok} expected={true} />
<AssertEquals actual={first.effects} expected={1} />

<IssueAttempt document="one-issue.md" forbidProviders={true} as="replayed" />
<AssertEquals actual={replayed.ok} expected={true} />
<AssertEquals actual={replayed.url} expected={first.url} />
<AssertEquals actual={replayed.calls} expected={0} />
<AssertEquals actual={replayed.effects} expected={1} />
</Test>

## A changed request cannot consume a retained result

The durable name moves with every member of the request — the target, the
discriminator, the title, the description, the tags and the assignee — so a
changed request diverges at its position rather than answering with the result
retained for a different question.

That claim is about the fingerprint, and it is asserted directly in
`issue-github.test.ts` rather than here. It cannot be staged by running a
*different document* against a retained journal: an edited root is a fork
(§11), and a fork replays the retained expansion positionally rather than
re-reading what the new document says. A scenario written that way would report
the first attempt's URL and look like a passing test of the opposite claim.

## What the run retains

The journal holds what a document asked for and the URL it got back. A
credential, a private endpoint, the marker a provider writes and a host path are
all things the provider holds and the boundary never carries.

<Test name="No credential, endpoint, marker or host path is retained">
<IssueFixture />
<IssueAttempt document="one-issue.md" as="attempt" />
<AssertEquals actual={attempt.ok} expected={true} />
<IssueJournal as="journal" />
<AssertNotMatch actual={journal.text} expected={/github-credential-for-this-scenario/} />
<AssertNotMatch actual={journal.text} expected={/api\.github\.test/} />
<AssertNotMatch actual={journal.text} expected={/Bearer/} />
<AssertNotMatch actual={journal.text} expected={/executablemd-issue:/} />
<AssertNotMatch actual={journal.text} expected={/node_id/} />
<AssertStringIncludes actual={journal.text} expected="https://github.com/octo/project" />
</Test>
