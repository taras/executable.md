---
props:
  config: { type: string }
  report: { type: string }
required: [config, report]
---
# Qualify a local ACP agent

You authorize the scenarios listed in your local configuration when you run this
example. Read README.md first. Your command uses its existing local credentials.

<LoadConfiguration path={props.config} as="local" />
<Let as="configuration" value={local.configuration} />

<Output>
<Qualify configuration={configuration} configFingerprint={local.fingerprint} report={props.report}>
  <AgentProvider name="acpx" defaultAgent={configuration.command} timeout="60s">
    <Availability as="admitted" />
    <If condition={admitted}>
      <Agent name={configuration.command}>
        <Session name="qualification-a" model={configuration.model} effort={configuration.effort}>
          <Prompt as="acknowledgement"><Marker stage="seed" /></Prompt>
          <Prompt as="recalled"><Marker stage="recall" /></Prompt>
          <CheckMarker scenario="continuity" reply={recalled} />
        </Session>
        <Session name="qualification-b" model={configuration.model} effort={configuration.effort}>
          <Prompt as="independent"><Marker stage="recall" /></Prompt>
          <CheckMarker scenario="separation" reply={independent} />
        </Session>
      </Agent>
    </If>
  </AgentProvider>
</Qualify>
</Output>
