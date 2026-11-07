---
props:
  agent: { type: string }
  session: { type: string }
  first: { type: string }
  second: { type: string }
---
<AgentProvider name="acpx" defaultAgent={props.agent} timeout="60s">
<Agent name={props.agent}>
<Session name={props.session}>
<Prompt>First reply with the exact line USAGE_CALIBRATION_READY. Then read {props.first} and {props.second} with separate native file-read tool calls and explain their contents in detail. Do not change files or start subagents.</Prompt>
</Session>
</Agent>
</AgentProvider>
