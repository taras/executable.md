<Capture as="rendered">

<Section title="Instruction Component">

The `<Instruction>` component surfaces the system prompt as visible,
composable document content. Instead of hiding the LLM's instructions
inside provider internals, authors wrap Sample calls with
`<Instruction system="...">` to define what the LLM is told.

Without an instruction, the provider uses a hardcoded default system
prompt. With `<Instruction>`, the author's text replaces that default:

<StubProvider model="instruction-stub">

<Instruction system="You are a helpful pirate.">
<Sample prompt="ahoy" model="instruction-stub" />
</Instruction>

</StubProvider>

Instructions accumulate through nesting. Agent components install
instruction middleware via `persist eval` blocks that enrich the
`SampleContext.system` field. When present, the system prompt is
passed through to the provider.

</Section>

</Capture>

{rendered}

<Test name="Instructions">
<AssertStringIncludes actual={rendered} expected={"\u00a7 Instruction Component"} />
<AssertStringIncludes actual={rendered} expected={"[response-from-instruction-stub|system:You are a helpful pirate.]"} />
</Test>
