---
props:
  type: object
  properties:
    repository: {type: string, minLength: 1}
    recipe: {type: object}
  required: [repository, recipe]
  additionalProperties: false
returns: {type: boolean}
---

<Return value={true} />
