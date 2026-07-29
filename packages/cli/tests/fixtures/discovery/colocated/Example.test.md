# Example

<Test name="a colocated component resolves from the target root">
<Capture as="rendered"><Example /></Capture>
<AssertEquals actual={rendered} expected={"Example component"} />
</Test>
