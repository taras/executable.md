---
props:
  agent: { type: string }
  session: { type: string }
  marker: { type: string }
---
<AgentProvider name="acpx" defaultAgent={props.agent} timeout="60s">
<Agent name={props.agent}>
<Session name={props.session}>
<Prompt>Remember this harmless calibration marker for our next request: {props.marker}. Reply with the marker. Use no tools.</Prompt>
</Session>
</Agent>
</AgentProvider>
