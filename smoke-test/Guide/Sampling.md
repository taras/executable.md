<Section title="Sample Component">

The `<Sample>` component captures its children's rendered output (or
accepts a `prompt` prop) and routes it through the Sample Api for LLM
processing. The stub provider echoes the content it received, so each
response proves which content reached the provider.

<StubProvider model="sample-stub">

Self-closing mode — prompt sent directly to the provider:

<Capture as="promptResponse"><Sample prompt="summarize this" model="sample-stub" /></Capture>

{promptResponse}

With children — children are rendered first, then sampled; the child
content is consumed by the provider rather than rendered directly:

<Capture as="childrenResponse"><Sample model="sample-stub">This is child content to be processed.</Sample></Capture>

{childrenResponse}

<Test name="Sampling">
<AssertEquals actual={promptResponse} expected={"\n[response-from-sample-stub|content:summarize this]"} />
<AssertEquals actual={childrenResponse} expected={"\n[response-from-sample-stub|content:This is child content to be processed.]"} />
</Test>

</StubProvider>

</Section>
