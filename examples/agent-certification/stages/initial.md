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
<Prompt throwOnError as="ack"><Marker stage="seed" /></Prompt>
<CheckMarker scenario="seed" reply={ack} />
<If condition={props.recall}>
<Prompt throwOnError as="recalled"><Marker stage="recall" /></Prompt>
<CheckMarker scenario="continuity" reply={recalled} />
</If>
</Session>
<If condition={props.separation}>
<Session name={props.names.b} model={props.configuration.model} effort={props.configuration.effort}>
<Prompt throwOnError as="independent"><Marker stage="recall" /></Prompt>
<CheckMarker scenario="separation" reply={independent} />
</Session>
</If>
</Agent>
</AgentProvider>
