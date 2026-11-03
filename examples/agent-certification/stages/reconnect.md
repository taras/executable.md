---
props:
  configuration: { type: object }
  names: { type: object }
  seed: { type: boolean }
  recall: { type: boolean }
  separation: { type: boolean }
  reconnect: { type: boolean }
  cancellation: { type: boolean }
  resume: { type: boolean }
---
<AgentProvider name="acpx" defaultAgent={props.configuration.command} timeout="60s">
<Agent name={props.configuration.command}>
<Session name={props.names.a} model={props.configuration.model} effort={props.configuration.effort}>
<Prompt throwOnError as="recalled"><Marker stage="recall" /></Prompt>
<CheckMarker scenario="reconnect" reply={recalled} />
</Session>
</Agent>
</AgentProvider>
