<Section title="Props and Interpolation">

Every component has access to two namespaces for interpolation:

- `{meta.key}` — the component's own frontmatter values
- `{props.key}` — values passed by the caller via JSX props

The Section component's frontmatter defines `emoji: §` which it
prepends to each title via `{meta.emoji}`. The Note component
uses `{meta.emoji}` for its 📝 prefix and `{props.message}` for
the caller-provided text.

<Capture as="propDemo"><PropDemo greeting="Hey" subject="world" /></Capture>

{propDemo}

<Test name="Props">
<AssertEquals actual={propDemo} expected={"\nThe caller said: \"Hey, world!\"\n\n\n> 📝 **info:** Props were successfully passed through to this component."} />
</Test>

</Section>
