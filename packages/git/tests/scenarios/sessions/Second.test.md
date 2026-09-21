# A second document, a second session

Nothing here files anything. The issue it finds is the one the first document
left, which is what makes the tracker shared rather than rebuilt — and this
document's results are its own, which is what makes the session separate.

<Test name="the second document meets the first document's tracker">
<TrackerIssues as="tracker" />
<AssertEquals actual={tracker.titles} expected={["Filed by the first document"]} />
</Test>
