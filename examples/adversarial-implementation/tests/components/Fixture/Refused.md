---
description: >-
  Require a refused decision envelope that keeps the prior continuation. Use
  <Fixture.Refused output={child.stdout} continuation={held.work.continuation}
  expected="stale continuation" as="refused" />.
props:
  type: object
  properties:
    output: {type: string}
    continuation: {type: object}
    expected: {type: string}
  required: [output, continuation, expected]
  additionalProperties: false
returns: {type: object}
---
<Parse schema={{type:"object"}} as="refused">{props.output}</Parse>
<If condition={refused.publication !== "held" || refused.status !== "hold" || refused.pending !== null || JSON.stringify(refused.continuation) !== JSON.stringify(props.continuation) || typeof refused.failure?.message !== "string" || !refused.failure.message.includes(props.expected)}>
<Fail message={"Expected a refusal containing " + JSON.stringify(props.expected) + " that keeps " + props.continuation.path + "; observed " + JSON.stringify(refused)} />
</If>
<Return value={refused} />
