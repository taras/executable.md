---
description: >-
  Validate the next phase and owner against the selected gate. Use <Phase.Next
  result={result} successor="review" role="planner" as="next" />.
props: {"type": "object", "properties": {"result": {"type": "object"}, "successor": {"enum": ["discovery", "implementation", "review", "ready"]}, "role": {"anyOf": [{"enum": ["architect", "planner", "implementor"]}, {"type": "null"}], "default": null}}, "required": ["result", "successor"], "additionalProperties": false}
returns: {type: object}
---

<Phase.Schema as="schemas" />
<Parse schema={schemas.result} as="result"><Json value={props.result} /></Parse>
<Phase.Route result={result} successor={props.successor} role={props.role} as="route" />
<If condition={!route.ok}><Fail message={route.rejection.message} /></If>
<Return value={route.value} />
