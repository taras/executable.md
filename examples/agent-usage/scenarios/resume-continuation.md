---
props:
  agent: { type: string }
  session: { type: string }
---
<AgentProvider name="acpx" defaultAgent={props.agent} timeout="60s">
<Agent name={props.agent}>
<Session name={props.session}>
<Prompt>Without tools, repeat the harmless calibration marker I gave you in our previous request.</Prompt>
</Session>
</Agent>
</AgentProvider>
