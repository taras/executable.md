---
props:
  input: { type: string }
  output: { type: string }
required: [input, output]
---
<ResumeStage input={props.input} output={props.output}>
<ResumeProps as="local" />
<AgentProvider name="acpx" defaultAgent={local.configuration.command} timeout="60s">
<Agent name={local.configuration.command}>
<Session name={local.names.a} model={local.configuration.model} effort={local.configuration.effort}>
<Prompt throwOnError as="recalled"><Marker stage="recall" /></Prompt>
<CheckMarker scenario="resume" reply={recalled} />
</Session>
</Agent>
</AgentProvider>
</ResumeStage>
