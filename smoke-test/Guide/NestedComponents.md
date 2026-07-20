<Section title="Nested Components">

Components can reference other components. When a component's body
contains another component invocation, the system resolves, imports, and
expands it recursively — with cycle detection to prevent infinite loops.
Dotted names map to directory paths: `<Tips.Formatting />` lives at
`components/Tips/Formatting.md`.

</Section>

<Test name="Feature expands its nested Note">
<Capture as="featureOutput"><Feature
  title="Recursive Expansion"
  description="Components expand bottom-up: children first, then the parent body."
/></Capture>
<AssertEquals actual={featureOutput} expected={"\n**Recursive Expansion** — Components expand bottom-up: children first, then the parent body.\n\n\n> 📝 **info:** This note was generated inside the Feature component."} />
</Test>

<Test name="Dotted component names resolve to directory paths">
<Capture as="formattingTip"><Tips.Formatting /></Capture>
<AssertEquals actual={formattingTip} expected={"\n💡 **Formatting tip:** Use `<Content />` inside your component\nbody to mark where the caller's children appear. If your component doesn't\ninclude `<Content />`, children are silently discarded."} />
</Test>
