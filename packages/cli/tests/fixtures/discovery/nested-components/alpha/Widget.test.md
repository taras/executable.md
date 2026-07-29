# Alpha

<Test name="Widget resolves beside the nested test that invokes it">
<Capture as="rendered"><Widget /></Capture>
<AssertEquals actual={rendered} expected={"Alpha widget"} />
</Test>
