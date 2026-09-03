---
props:
  type: object
  properties:
    request: { type: string }
    session: { type: string }
  required: [request, session]
  additionalProperties: false
returns:
  type: string
---
<Plan session={props.session} as="approved">{props.request}</Plan>
<Return value={approved} />
