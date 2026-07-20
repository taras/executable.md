<Section title="Component-declared Output">

A component can declare which region of its body renders using `<Output>`.
Everything outside the region is documentation that executes (its eval blocks
run, its captures populate bindings) but never renders into the consumer.
`OutputDemo` computes a binding in documentation, then renders a `<Show>`
inside `<Output>` that depends on it.

</Section>

<Test name="Output regions render only the selected region">
<Capture as="outputDemo"><OutputDemo /></Capture>
<AssertEquals actual={outputDemo} expected={"\n\n\n\n\nOUTPUTDEMO_SELECTED"} />
<AssertNotMatch actual={outputDemo} expected={/OUTPUTDEMO_DOC_LEAK/} />
</Test>
