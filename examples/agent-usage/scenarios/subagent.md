---
props:
  agent: { type: string }
  session: { type: string }
  first: { type: string }
---
<AgentProvider name="acpx" defaultAgent={props.agent} timeout="60s">
<Agent name={props.agent}>
<Session name={props.session}>
<Prompt>Ask one native subagent to read {props.first} and return its marker. Do not read the file yourself. If native subagents are unavailable, say unavailable and stop. Do not change files.</Prompt>
</Session>
</Agent>
</AgentProvider>
