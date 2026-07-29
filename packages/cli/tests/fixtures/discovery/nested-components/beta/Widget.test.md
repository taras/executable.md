# Beta

<Test name="a same-named component in a sibling directory does not leak">
<Capture as="rendered"><Widget /></Capture>
<AssertEquals actual={rendered} expected={"Beta widget"} />
</Test>
