---
description: 'Select the registered provider name for a workflow role. Use <Phase.ProviderName agent="claude" as="provider" /> and wrap the authored role session in <AgentProvider name={provider}>.'
props:
  type: object
  properties:
    agent: {type: string}
  required: [agent]
  additionalProperties: false
returns: {type: string}
---

<Return value={props.agent === "claude" ? "claude-workflow-role" : "acpx"} />
