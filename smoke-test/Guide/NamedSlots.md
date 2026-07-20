<Section title="Named Slots">

Components can render caller-provided content in multiple distinct
regions using named slots. The `slot` prop on child components directs
content to matching `<Content slot="name" />` positions in the
component body, and children without a `slot` prop go to the default
slot.

</Section>

<Test name="Named slots place content in their regions">
<Capture as="slotTable"><TwoColumn>
  <Fragment slot="left">**Left column** content via named slot.</Fragment>
  <Fragment slot="right">**Right column** content via named slot.</Fragment>
</TwoColumn></Capture>
<AssertEquals actual={slotTable} expected={"\n| Left | Right |\n|------|-------|\n| \n**Left column** content via named slot.\n | \n**Right column** content via named slot.\n |"} />
</Test>

<Test name="Named slots compose with the default slot">
<Capture as="slotTableNotes"><TwoColumn>
  <Note slot="left" message="This note is in the left column." />
  <Note slot="right" message="This note is in the right column." />
</TwoColumn></Capture>
<AssertEquals actual={slotTableNotes} expected={"\n| Left | Right |\n|------|-------|\n| \n> 📝 **info:** This note is in the left column.\n | \n> 📝 **info:** This note is in the right column.\n |"} />
</Test>
