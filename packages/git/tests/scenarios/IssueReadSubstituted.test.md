# A substituted answer is not retained, and not replayed

Two attempts of one run, both reading issue 1 from a tracker that answers with
issue 99.

The claim is about what the run keeps. Retaining the substituted answer would be
worse than the substitution itself: the second attempt would restore issue 99
without asking anybody, and it would restore it under the URL of issue 1.

<StagedAttempt index={0} as="first" />
<StagedAttempt index={1} as="second" />

## Neither attempt bound it

<Test name="both attempts refused, naming the substitution">
<AssertEquals actual={first.ok} expected={false} />
<AssertEquals actual={second.ok} expected={false} />
<AssertStringIncludes actual={first.error} expected="a different issue than the one requested" />
<AssertStringIncludes actual={second.error} expected="a different issue than the one requested" />
</Test>

<Test name="the other issue appears in neither attempt's output">
<AssertEquals actual={first.output} expected={second.output} />
<AssertNotMatch actual={first.output} expected={/A different issue entirely/} />
<AssertNotMatch actual={second.output} expected={/elsewhere/} />
</Test>

## And what the run retained was the refusal

The refusal is journaled, so the second attempt restored it instead of asking
again. That is the discriminating fact: had the substituted answer been retained
as this read's outcome, the replay would have bound issue 99 and succeeded
without a request. It refused, with the same words, having sent nothing.

<Test name="the retained record is the refusal, not the substituted answer">
<IssueJournal as="journal" />
<AssertEquals actual={journal.effects} expected={1} />
<AssertEquals actual={second.calls} expected={0} />
<AssertEquals actual={second.ok} expected={false} />
</Test>

<Test name="one request, addressed to the issue that was asked for">
<ServerRequests as="sent" />
<AssertEquals actual={sent.methods} expected={["GET"]} />
<AssertEquals actual={sent.paths} expected={["/repos/octo/project/issues/1"]} />
</Test>

<Test name="the retained record holds nothing private to the provider or the host">
<IssueJournal as="journal" />
<AssertEquals actual={journal.retains.payload} expected={false} />
<AssertEquals actual={journal.retains.providerId} expected={false} />
<AssertEquals actual={journal.retains.endpoint} expected={false} />
<AssertEquals actual={journal.retains.credential} expected={false} />
</Test>
