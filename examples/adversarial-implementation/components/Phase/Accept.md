---
description: >-
  Validate a saved role reply against its phase and source identity. Use <Phase.Accept
  assignment={prepared.assignment} text={reply} as="result" />.
props: {"type": "object", "properties": {"assignment": {"type": "object"}, "text": {"type": "string"}, "role": {"anyOf": [{"enum": ["architect", "planner", "implementor"]}, {"type": "null"}], "default": null}, "profile": {"type": "object", "default": {"kind": "phase", "knownDocuments": []}}}, "required": ["assignment", "text"], "additionalProperties": false}
returns: {type: object}
---

<Phase.Response assignment={props.assignment} text={props.text} role={props.role} profile={props.profile} as="checked" />
<If condition={!checked.ok}><Fail message={checked.rejection.message} /></If>
<Phase.Schema as="schemas" />
<Parse schema={schemas.result} as="result"><Json value={checked.value} /></Parse>
<Return value={result} />
