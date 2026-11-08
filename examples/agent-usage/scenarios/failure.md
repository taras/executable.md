---
props:
  agent: { type: string }
  session: { type: string }
  denied: { type: string }
---
<AgentProvider name="acpx" defaultAgent={props.agent} timeout="60s">
<Agent name={props.agent}>
<Session name={props.session}>
<Prompt>Use your native file-write tool to write the text calibration into {props.denied}. Do not use a shell or another tool. If permission is denied, do not try another method.</Prompt>
</Session>
</Agent>
</AgentProvider>
