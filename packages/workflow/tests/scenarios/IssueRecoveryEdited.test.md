# A retry that found its issue saying something else

One request, one run. The first attempt filed the issue and its process ended
before it could record that. Between the attempts somebody rewrote the title.

This is the one hazard that is not a refusal. The issue carries this key's
marker, it is open, and it is in the repository the request named — so it is
this request's issue, and the request still says what it says. The retry updates
it in place rather than filing a second one.

<StagedAttempt index={0} as="interrupted" />
<StagedAttempt index={1} as="retried" />

<Test name="the interruption left an issue and no record of it">
<AssertEquals actual={interrupted.ok} expected={false} />
<AssertEquals actual={interrupted.effects} expected={0} />
</Test>

<Test name="the retry succeeded by adopting it">
<AssertEquals actual={retried.error} expected="" />
<AssertEquals actual={retried.ok} expected={true} />
</Test>

The update is a PATCH of that issue by number — the only request in these
scenarios that addresses one issue rather than the collection — and it is
followed by a read. What the issue holds afterwards is decided by the tracker's
own answer rather than by what the call optimistically said.

<Test name="the retry read the collection, patched that issue, and read it back">
<ServerRequests as="sent" />
<AssertEquals actual={sent.methods} expected={["GET", "POST", "GET", "PATCH", "GET"]} />
<AssertEquals actual={sent.paths[3]} expected="/repos/octo/project/issues/1" />
</Test>

The PATCH carries only what differs. The description was never edited, so the
body is not in it — and because the marker travels in the body, the update does
not rewrite the marker either.

<Test name="the update sends only the field that changed">
<ServerRequests as="sent" />
<AssertEquals actual={sent.bodyKeys[3]} expected={["title"]} />
<AssertEquals actual={sent.titles[3]} expected="Retry the publish step" />
<AssertEquals actual={sent.markers} expected={1} />
</Test>

<Test name="one issue, saying what the request says">
<TrackerIssues as="tracker" />
<AssertEquals actual={tracker.count} expected={1} />
<AssertEquals actual={tracker.titles} expected={["Retry the publish step"]} />
</Test>
