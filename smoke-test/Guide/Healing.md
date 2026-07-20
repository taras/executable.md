<Section title="Markdown Healing">

Components and executable code blocks are **semantic boundaries**.
Markdown constructs cannot span them. Each text segment is healed
independently using remend: if bold is opened before a component but not
closed, remend closes it before expansion proceeds, so unclosed markers
cannot bleed into component output.

<Capture as="healed">The text below opens **bold before the component
<Badge />
and continues after.</Capture>

{healed}

<Test name="Healing">
<AssertEquals actual={healed} expected={"The text below opens **bold before the component\n**\n*✓ verified*\n\nand continues after."} />
</Test>

</Section>
