<Capture as="rendered">

<Section title="Components">

A component is a markdown file with a declared interface. The component's
frontmatter defines its own metadata and the props it accepts
via `inputs`. Here's the frontmatter from the Note component used below:

```yaml
# components/Note.md frontmatter
emoji: 📝
inputs:
  level: info
  message:
    type: string
    required: true
```

Components are invoked with JSX syntax. Props must match the declared
inputs — undeclared props are rejected, required props must be provided,
and defaults fill in for omitted optional props.

<Note message="This note uses the default level (info)." />

<Note level="warning" message="This note overrides the level to warning." />

Components can wrap content using the `<Content />` slot. The Section
component wrapping this text works exactly that way — it receives a
title prop and renders its children inside a headed section.

</Section>

</Capture>

{rendered}

<Test name="Components">
<AssertStringIncludes actual={rendered} expected={"\u00a7 Components"} />
<AssertStringIncludes actual={rendered} expected={"\ud83d\udcdd **info:** This note uses the default level (info)."} />
<AssertStringIncludes actual={rendered} expected={"\ud83d\udcdd **warning:** This note overrides the level to warning."} />
</Test>
