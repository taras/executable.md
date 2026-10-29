---
description: >-
  Retain a reviewer's conditional acceptance before implementation. Use
  <ExactCorrection.Prepare assignment={assignment} result={result} role="planner"
  resultPath={resultPath} as="approval" />.
props:
  type: object
  properties:
    assignment: {type: object}
    result: {type: object}
    role: {enum: [architect, planner, implementor]}
    resultPath: {type: string, pattern: '^/'}
  required: [assignment, result, role, resultPath]
  additionalProperties: false
returns: {type: object}
---
<ExactCorrection.Validate assignment={props.assignment} result={props.result} role={props.role} as="offer" />
<Ticket.Checkout repository={props.assignment.repository} as="checkout" />
<Dir path={props.assignment.repository}>
```bash exec as="untracked"
git status --porcelain=v1 --untracked-files=all
```
</Dir>
<If condition={untracked.exitCode !== 0 || untracked.stdout.length !== 0}><Fail message="Exact correction requires a checkout without untracked or modified files." /></If>
<If condition={!checkout.clean || checkout.head !== offer.baseRevision}><Fail message="Conditional acceptance must inspect the actual clean base." /></If>
<Ticket.Signature repository={props.assignment.repository} revision={offer.baseRevision} as="signature" />
<If condition={signature.exitCode !== 0}><Fail message="The conditionally accepted base is not verified signed feedback." /></If>
<ExactCorrection.Patch repository={props.assignment.repository} offer={offer} as="patch" />
<Return value={{schema:"exact-correction-approval.v1",role:props.role,result:props.resultPath,offer,checkout,signature,patch}} />
