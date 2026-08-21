# One document, one session

This document and the one beside it are observed against a single fixture. What
each proves is about the boundary between them: the tracker is shared, and the
testing session is not.

It files an issue on the fixture's tracker, and sees only that one.

<RemoteIssue number={1} title="Filed by the first document" />

<Test name="the first document sees the tracker it filed on">
<ServerRequests as="sent" />
<AssertEquals actual={sent.titles} expected={["Filed by the first document"]} />
</Test>
