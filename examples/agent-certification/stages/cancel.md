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
<Session name={props.names.c} model={props.configuration.model} effort={props.configuration.effort}>
<Prompt throwOnError text="Wait for cancellation. Keep working on this turn until the host cancels it. Use no tools." />
</Session>
</Agent>
</AgentProvider>
