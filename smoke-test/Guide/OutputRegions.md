<Capture as="rendered">

<Section title="Component-declared Output">

A component can declare which region of its body renders using `<Output>`.
Everything outside the region is documentation that executes (its eval blocks
run, its captures populate bindings) but never renders into the consumer.
`OutputDemo` computes a binding in documentation, then renders a `<Show>`
inside `<Output>` that depends on it.

<OutputDemo />

</Section>

</Capture>

{rendered}

<Test name="Output regions">
<AssertStringIncludes actual={rendered} expected={"\u00a7 Component-declared Output"} />
<AssertStringIncludes actual={rendered} expected={"OUTPUTDEMO_SELECTED"} />
<AssertNotMatch actual={rendered} expected={/OUTPUTDEMO_DOC_LEAK/} />
</Test>
