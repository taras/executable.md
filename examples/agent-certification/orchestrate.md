---
props:
  config: { type: string }
  prompt: { type: string }
required: [config, prompt]
---
# Use a locally configured agent

<LoadConfiguration path={props.config} as="local" />
<Let as="configuration" value={local.configuration} />

<Output>
<Agent name={configuration.command}>
  <Session name="local-work" model={configuration.model} effort={configuration.effort}>
    <Prompt text={props.prompt} timeout="60s" />
  </Session>
</Agent>
</Output>
