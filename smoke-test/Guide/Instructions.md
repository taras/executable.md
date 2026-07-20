<Section title="Instruction Component">

The `<Instruction>` component surfaces the system prompt as visible,
composable document content. Instead of hiding the LLM's instructions
inside provider internals, authors wrap Sample calls with
`<Instruction system="...">` to define what the LLM is told. The stub
provider echoes the system prompt it received, so the response proves
what the provider was told.

</Section>

<Test name="Instruction sets the provider system prompt">
<StubProvider model="instruction-stub">
<Capture as="instructionResponse"><Instruction system="You are a helpful pirate.">
<Sample prompt="ahoy" model="instruction-stub" />
</Instruction></Capture>
<AssertEquals actual={instructionResponse} expected={"\n\n\n\n[response-from-instruction-stub|system:You are a helpful pirate.|content:ahoy]"} />
</StubProvider>
</Test>
