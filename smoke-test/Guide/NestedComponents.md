<Capture as="rendered">

<Section title="Nested Components">

Components can reference other components. When a component's body
contains another component invocation, the system resolves, imports, and
expands it recursively — with cycle detection to prevent infinite loops.

<Feature
  title="Recursive Expansion"
  description="Components expand bottom-up: children first, then the parent body."
/>

Dotted names map to directory paths. The component below lives at
`components/Tips/Formatting.md`:

<Tips.Formatting />

</Section>

</Capture>

{rendered}

<Test name="Nested components">
<AssertStringIncludes actual={rendered} expected={"\u00a7 Nested Components"} />
<AssertStringIncludes actual={rendered} expected={"**Recursive Expansion**"} />
<AssertStringIncludes actual={rendered} expected={"Components expand bottom-up"} />
<AssertStringIncludes actual={rendered} expected={"This note was generated inside the Feature component."} />
<AssertStringIncludes actual={rendered} expected={"\ud83d\udca1 **Formatting tip:**"} />
<AssertStringIncludes actual={rendered} expected={"<Content />"} />
</Test>
