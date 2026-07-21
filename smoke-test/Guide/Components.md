<Section title="Components">

A component is a markdown file with a declared interface. The component's
frontmatter defines its own metadata and the props it accepts
via `inputs`. Here's the frontmatter from the Note component tested below:

```yaml
# components/Note.md frontmatter
emoji: 📝
inputs:
  type: object
  properties:
    level:
      type: string
      default: info
    message:
      type: string
  required: [message]
  additionalProperties: false
```

Components are invoked with JSX syntax. Props must match the declared
inputs — undeclared props are rejected, required props must be provided,
and defaults fill in for omitted optional props. Components wrap caller
content through the `<Content />` slot, the way the Section component
around this text renders its children inside a headed section.

</Section>

<Test name="Note renders its default level">
<Capture as="noteDefault"><Note message="This note uses the default level (info)." /></Capture>
<AssertEquals actual={noteDefault} expected={"\n> 📝 **info:** This note uses the default level (info)."} />
</Test>

<Test name="Note renders an overridden level">
<Capture as="noteOverride"><Note level="warning" message="This note overrides the level to warning." /></Capture>
<AssertEquals actual={noteOverride} expected={"\n> 📝 **warning:** This note overrides the level to warning."} />
</Test>

<Test name="Section renders children through its Content slot">
<Capture as="slotSentinel"><Section title="Slot Sentinel">SENTINEL-CONTENT</Section></Capture>
<AssertEquals actual={slotSentinel} expected={"\n## § Slot Sentinel\n\nSENTINEL-CONTENT\n\n---"} />
</Test>
