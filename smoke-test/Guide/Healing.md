<Capture as="rendered">

<Section title="Markdown Healing">

Components and executable code blocks are **semantic boundaries**.
Markdown constructs cannot span them. Each text segment is healed
independently using remend.

For example, if bold is opened before a component but not closed,
remend closes it before expansion proceeds. This prevents unclosed
markers from bleeding into component output.

The text below opens \*\*bold before the component
<Badge />
and continues after. Each segment is independently valid markdown.

</Section>

</Capture>

{rendered}

<Test name="Healing">
<AssertStringIncludes actual={rendered} expected={"\u00a7 Markdown Healing"} />
<AssertStringIncludes actual={rendered} expected={"\u2713 verified"} />
</Test>
