# Beta

<Test name="a same-named component in a sibling directory does not leak">
<Let as="rendered"><Widget /></Let>
<AssertEquals actual={rendered} expected={"Beta widget"} />
</Test>
