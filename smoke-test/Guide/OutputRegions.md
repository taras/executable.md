<Section title="Component-declared Output">

A component can declare which region of its body renders using `<Output>`.
Everything outside the region is documentation that executes (its eval blocks
run, its captures populate bindings) but never renders into the consumer.
`OutputDemo` computes a binding in documentation, then renders a `<Show>`
inside `<Output>` that depends on it.

<Capture as="outputDemo"><OutputDemo /></Capture>

{outputDemo}

<Test name="Output regions">
<AssertEquals actual={outputDemo} expected={"\n\n\n\n\nOUTPUTDEMO_SELECTED"} />
<AssertNotMatch actual={outputDemo} expected={/OUTPUTDEMO_DOC_LEAK/} />
</Test>

</Section>
