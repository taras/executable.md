---
props:
  type: object
  properties:
    assignment: {type: object}
    previous: {type: object}
  required: [assignment, previous]
  additionalProperties: false
---

<If condition={props.previous.failingRevision !== undefined && props.assignment.failingRevision !== undefined && props.previous.failingRevision !== props.assignment.failingRevision}>
<Fail message="The failing revision differs from the original diagnostic assignment. Use a fresh assignment for a different failing revision." />
</If>
