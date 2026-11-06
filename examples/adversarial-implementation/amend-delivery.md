---
props:
  type: object
  properties:
    record: {type: string, minLength: 1}
    grant: {type: string, minLength: 1}
    action: {enum: [admit, select], default: admit}
  additionalProperties: false
---
Admit one measured-weights delivery amendment for a completed ticket. Admission
starts no role; continue the returned envelope with `continue.md`. `select`
prints the running workflow sources an authorization must name.

<Entry.Amend record={props.record} grant={props.grant} action={props.action} as="work" />
<Output><Json value={work} /></Output>
