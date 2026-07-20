The Section component receives a title prop and renders its children
inside a headed section via the `<Content />` slot. The sentinel below
proves the slot renders caller content in place:

<Capture as="slotSentinel"><Section title="Slot Sentinel">SENTINEL-CONTENT</Section></Capture>

{slotSentinel}

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

<Capture as="noteDefault"><Note message="This note uses the default level (info)." /></Capture>

{noteDefault}

<Capture as="noteOverride"><Note level="warning" message="This note overrides the level to warning." /></Capture>

{noteOverride}

<Test name="Components">
<AssertEquals actual={noteDefault} expected={"\n> 📝 **info:** This note uses the default level (info)."} />
<AssertEquals actual={noteOverride} expected={"\n> 📝 **warning:** This note overrides the level to warning."} />
<AssertEquals actual={slotSentinel} expected={"\n## § Slot Sentinel\n\nSENTINEL-CONTENT\n\n---"} />
</Test>

</Section>
