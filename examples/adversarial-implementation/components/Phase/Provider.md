---
description: 'Apply the Claude workflow-role launch controls for this content. Use <Phase.Provider agent="claude">...</Phase.Provider>.'
props:
  type: object
  properties:
    agent: {type: string}
  required: [agent]
  additionalProperties: false
---

<If condition={props.agent === "claude"}>
<AgentProvider name="claude-workflow-role" defaultAgent="claude"><Content /></AgentProvider>
<Else><Content /></Else>
</If>
