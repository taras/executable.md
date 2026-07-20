<Capture as="rendered">

<Section title="Props and Interpolation">

Every component has access to two namespaces for interpolation:

- `{meta.key}` — the component's own frontmatter values
- `{props.key}` — values passed by the caller via JSX props

The Section component's frontmatter defines `emoji: §` which it
prepends to each title via `{meta.emoji}`. The Note component
uses `{meta.emoji}` for its 📝 prefix and `{props.message}` for
the caller-provided text.

<PropDemo greeting="Hey" subject="world" />

</Section>

</Capture>

{rendered}

<Test name="Props">
<AssertStringIncludes actual={rendered} expected={"\u00a7 Props and Interpolation"} />
<AssertStringIncludes actual={rendered} expected={"\"Hey, world!\""} />
</Test>
