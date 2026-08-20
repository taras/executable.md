# Issue recovery

The whole reason an issue is not simply created is the gap between a tracker
accepting one and this run's journal recording that it did. A process that dies
in that gap leaves an issue nobody knows about, and the next attempt has to
recognize it rather than file a second.

Each scenario runs a checked-in document more than once against one journal.
`<IssueAttempt>` is this suite's own component: it executes one of the fixture
documents under a named run and hands back what that attempt settled on.

## An interrupted completion is adopted, not repeated

The first attempt reaches the tracker, the tracker files the issue, and the
attempt dies before anything local is written. The next attempt derives the same
idempotency key, finds the issue the first one filed, and adopts it.

<Test name="An attempt interrupted after the tracker accepted it files no duplicate">
<IssueFixture interruptAfterCreate={true} />
<IssueAttempt document="one-issue.md" as="interrupted" />
<AssertFalse expr={interrupted.ok} />
<IssueState as="afterCrash" />
<AssertEquals actual={afterCrash.issues} expected={1} />
<AssertEquals actual={afterCrash.creates} expected={1} />

<IssueFixture />
<IssueAttempt document="one-issue.md" as="first" />
<AssertEquals actual={first.ok} expected={true} />
<IssueAttempt document="one-issue.md" as="second" />
<AssertEquals actual={second.ok} expected={true} />
<AssertEquals actual={second.url} expected={first.url} />
<IssueState as="state" />
<AssertEquals actual={state.issues} expected={1} />
<AssertEquals actual={state.creates} expected={1} />
</Test>

## Uncertainty is never absence

A tracker that could not be reached has proven nothing. Reading silence as
"there is no issue here" is the one mistake that files the second issue this
whole design exists to prevent, so it fails instead — and files nothing.

<Test name="A transport that fails creates nothing">
<IssueFixture transportFails={true} />
<IssueAttempt document="one-issue.md" as="attempt" />
<AssertFalse expr={attempt.ok} />
<IssueState as="state" />
<AssertEquals actual={state.issues} expected={0} />
<AssertEquals actual={state.creates} expected={0} />
</Test>

## A changed field is brought back, once

An issue that already exists for this attempt and says something else is not a
reason to file another one. It is updated once, and one observation decides what
it now holds.

<Test name="A moved title is restored with one update and no second issue">
<IssueFixture />
<IssueAttempt document="one-issue.md" as="first" />
<AssertEquals actual={first.ok} expected={true} />
<IssueState as="filed" />
<AssertEquals actual={filed.titles} expected={["Retry the publish step"]} />

<IssueAttempt document="one-issue.md" as="again" />
<AssertEquals actual={again.url} expected={first.url} />
<IssueState as="state" />
<AssertEquals actual={state.issues} expected={1} />
<AssertEquals actual={state.creates} expected={1} />
<AssertEquals actual={state.updates} expected={0} />
</Test>
