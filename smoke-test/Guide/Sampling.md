<Section title="Sample Component">

The `<Sample>` component captures its children's rendered output (or
accepts a `prompt` prop) and routes it through the Sample Api for LLM
processing. The stub provider echoes the content it received, so each
response proves which content reached the provider — and, in children
mode, that the child content was consumed rather than rendered directly.

</Section>

<Test name="Sample sends its prompt to the provider">
<StubProvider model="sample-stub">
<Capture as="promptResponse"><Sample prompt="summarize this" model="sample-stub" /></Capture>
<AssertEquals actual={promptResponse} expected={"\n[response-from-sample-stub|content:summarize this]"} />
</StubProvider>
</Test>

<Test name="Sample consumes children as content">
<StubProvider model="sample-stub">
<Capture as="childrenResponse"><Sample model="sample-stub">This is child content to be processed.</Sample></Capture>
<AssertEquals actual={childrenResponse} expected={"\n[response-from-sample-stub|content:This is child content to be processed.]"} />
</StubProvider>
</Test>
