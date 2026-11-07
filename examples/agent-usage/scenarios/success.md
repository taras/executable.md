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
<Prompt>Read {props.first} with one native file-read tool call. Then read {props.second} with a second native file-read tool call. Do not combine the reads in one command. Reply with the two markers you read. Do not change files or start subagents.</Prompt>
<Prompt>Without tools, repeat the two markers you read in the previous request.</Prompt>
</Session>
</Agent>
</AgentProvider>
