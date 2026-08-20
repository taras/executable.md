# Issue recovery

The whole reason an issue is not simply created is the gap between a tracker
accepting one and this run's journal recording that it did. A process that dies
in that gap leaves an issue nobody knows about, and the next attempt has to
recognize it rather than file a second.

`<IssueAttempt>` runs one of the checked-in fixture documents under a named run.
`<IssueFixture>` resets everything; `<IssueFault>` changes only what is failing,
which is what lets an attempt continue from the state the one before it left —
the tracker's contents and the journal both survive it.

## An interrupted completion is adopted, not repeated

The first attempt reaches the tracker, the tracker files the issue, and the
attempt dies before anything local is written. The next attempt derives the same
key, finds what the first one filed, and adopts it.

<Test name="An attempt interrupted after the tracker accepted it files no duplicate">
<IssueFixture interruptAfterCreate={true} />
<IssueAttempt document="one-issue.md" as="interrupted" />
<AssertFalse expr={interrupted.ok} />
<IssueState as="afterCrash" />
<AssertEquals actual={afterCrash.issues} expected={1} />
<AssertEquals actual={afterCrash.creates} expected={1} />

<IssueFault />
<IssueAttempt document="one-issue.md" as="recovered" />
<AssertEquals actual={recovered.ok} expected={true} />
<AssertExists actual={recovered.url} />

<IssueState as="state" />
<AssertEquals actual={state.issues} expected={1} />
<AssertEquals actual={state.creates} expected={1} />
<AssertEquals actual={state.keys.length} expected={2} />
<AssertEquals actual={state.keys[0]} expected={state.keys[1]} />
<AssertGreater actual={recovered.calls} expected={0} />
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

## A changed remote state is brought back, once

An issue that already carries this attempt's mark and says something else is not
a reason to file another one. It is updated once, and one observation decides
what it now holds.

<Test name="A retitled issue is restored with one update and no second issue">
<IssueFixture interruptAfterCreate={true} />
<IssueAttempt document="one-issue.md" as="interrupted" />
<AssertFalse expr={interrupted.ok} />
<IssueRemote retitle="Somebody rewrote this" />

<IssueFault />
<IssueAttempt document="one-issue.md" as="recovered" />
<AssertEquals actual={recovered.ok} expected={true} />
<IssueState as="state" />
<AssertEquals actual={state.issues} expected={1} />
<AssertEquals actual={state.creates} expected={1} />
<AssertEquals actual={state.updates} expected={1} />
<AssertEquals actual={state.titles} expected={["Retry the publish step"]} />
</Test>

## Ambiguity, conflict and a closed issue each refuse

Two issues carrying one mark is a state this attempt cannot name. An issue that
has moved to another repository, and one somebody has closed, are each proven to
be *this* attempt's issue and not something to act on. None of them is absence,
and none of them files a second issue.

<Test name="Two issues carrying one mark refuse rather than adopt either">
<IssueFixture interruptAfterCreate={true} />
<IssueAttempt document="one-issue.md" as="interrupted" />
<AssertFalse expr={interrupted.ok} />
<IssueRemote duplicate={true} />

<IssueFault />
<IssueAttempt document="one-issue.md" as="recovered" />
<AssertFalse expr={recovered.ok} />
<IssueState as="state" />
<AssertEquals actual={state.issues} expected={2} />
<AssertEquals actual={state.creates} expected={1} />
<AssertEquals actual={state.updates} expected={0} />
</Test>

<Test name="An issue that moved to another repository refuses">
<IssueFixture interruptAfterCreate={true} />
<IssueAttempt document="one-issue.md" as="interrupted" />
<AssertFalse expr={interrupted.ok} />
<IssueRemote move={true} />

<IssueFault />
<IssueAttempt document="one-issue.md" as="recovered" />
<AssertFalse expr={recovered.ok} />
<IssueState as="state" />
<AssertEquals actual={state.issues} expected={1} />
<AssertEquals actual={state.creates} expected={1} />
<AssertEquals actual={state.updates} expected={0} />
</Test>

<Test name="An issue somebody closed refuses rather than reopening or duplicating">
<IssueFixture interruptAfterCreate={true} />
<IssueAttempt document="one-issue.md" as="interrupted" />
<AssertFalse expr={interrupted.ok} />
<IssueRemote close={true} />

<IssueFault />
<IssueAttempt document="one-issue.md" as="recovered" />
<AssertFalse expr={recovered.ok} />
<IssueState as="state" />
<AssertEquals actual={state.issues} expected={1} />
<AssertEquals actual={state.states} expected={["closed"]} />
<AssertEquals actual={state.creates} expected={1} />
<AssertEquals actual={state.updates} expected={0} />
</Test>
