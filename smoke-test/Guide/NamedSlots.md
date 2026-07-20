<Capture as="rendered">

<Section title="Named Slots">

Components can render caller-provided content in multiple distinct
regions using named slots. The `slot` prop on child components directs
content to matching `<Content slot="name" />` positions in the
component body.

<TwoColumn>
  <Fragment slot="left">
    **Left column** content via named slot.
  </Fragment>
  <Fragment slot="right">
    **Right column** content via named slot.
  </Fragment>
</TwoColumn>

Named slots compose with the existing content slot. Children without
a `slot` prop go to the default slot:

<TwoColumn>
  <Note slot="left" message="This note is in the left column." />
  <Note slot="right" message="This note is in the right column." />
</TwoColumn>

</Section>

</Capture>

{rendered}

<Test name="Named slots">
<AssertStringIncludes actual={rendered} expected={"\u00a7 Named Slots"} />
<AssertStringIncludes actual={rendered} expected={"**Left column** content via named slot."} />
<AssertStringIncludes actual={rendered} expected={"**Right column** content via named slot."} />
</Test>
