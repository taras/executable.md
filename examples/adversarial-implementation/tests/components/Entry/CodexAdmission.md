---
props:
  type: object
  properties:
    repository: {type: string, minLength: 1}
    model: {type: string, minLength: 1}
    effort: {type: string, minLength: 1}
  required: [repository, model, effort]
  additionalProperties: false
returns: {type: boolean}
---

<Return value={true} />
