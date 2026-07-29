# Reads

The reference below stays verbatim because the binding belongs to another
document: {leaked}

<Test name="a binding from an earlier document is not visible">
<Capture as="observed">{leaked}</Capture>
<AssertEquals actual={observed} expected={"{leaked}"} />
</Test>
