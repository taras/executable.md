<Section title="Nested Components">

Components can reference other components. When a component's body
contains another component invocation, the system resolves, imports, and
expands it recursively — with cycle detection to prevent infinite loops.

<Capture as="featureOutput"><Feature
  title="Recursive Expansion"
  description="Components expand bottom-up: children first, then the parent body."
/></Capture>

{featureOutput}

Dotted names map to directory paths. The component below lives at
`components/Tips/Formatting.md`:

<Capture as="formattingTip"><Tips.Formatting /></Capture>

{formattingTip}

<Test name="Nested components">
<AssertEquals actual={featureOutput} expected={"\n**Recursive Expansion** — Components expand bottom-up: children first, then the parent body.\n\n\n> 📝 **info:** This note was generated inside the Feature component."} />
<AssertEquals actual={formattingTip} expected={"\n💡 **Formatting tip:** Use `<Content />` inside your component\nbody to mark where the caller's children appear. If your component doesn't\ninclude `<Content />`, children are silently discarded."} />
</Test>

</Section>
