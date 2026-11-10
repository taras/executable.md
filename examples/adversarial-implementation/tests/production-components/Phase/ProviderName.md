---
props:
  type: object
  properties:
    agent: {type: string}
  required: [agent]
  additionalProperties: false
returns: {type: string}
---

<Return value={props.agent === "claude" ? "test-agent" : "acpx"} />
