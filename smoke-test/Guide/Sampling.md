<Capture as="rendered">

<Section title="Sample Component">

The `<Sample>` component captures its children's rendered output (or
accepts a `prompt` prop) and routes it through the Sample Api for LLM
processing. It uses `output()` to produce rendered output and
`renderChildren()` to capture children.

Self-closing mode — prompt sent directly to the provider:

<StubProvider model="sample-stub">

<Sample prompt="summarize this" model="sample-stub" />

With children — children are rendered first, then sampled:

<Sample model="sample-stub">
This is child content to be processed.
</Sample>

</StubProvider>

</Section>

</Capture>

{rendered}

<Test name="Sampling">
<AssertStringIncludes actual={rendered} expected={"\u00a7 Sample Component"} />
<AssertStringIncludes actual={rendered} expected={"[response-from-sample-stub]"} />
</Test>
