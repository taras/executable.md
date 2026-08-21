# A document whose assertion does not hold

Observed alongside the other two, and expected to fail. A scenario runner that
reported this document as passing would report every silently skipped suite as
passing too, so the failure is asserted rather than avoided.

<Test name="an assertion that does not hold">
<AssertEquals actual={1} expected={2} />
</Test>
