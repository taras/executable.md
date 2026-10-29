---
description: 'Save a Planner attempt and validate its API before handing over. Use <Adversarial.Foundation assignment={assignment} guide={guide} as="foundation" />.'
props:
  type: object
  properties:
    assignment: {type: object}
    guide: {type: string}
  required: [assignment, guide]
  additionalProperties: false
returns: {type: object}
---

<Let as="assignment" value={props.assignment} />
<Ticket.Checkout repository={assignment.repository} as="before" />
<If condition={!before.clean || before.head !== assignment.revision}><Fail message="Reconcile the actual checkout before starting the original Planner." /></If>
<Let as="quoted" value={"'" + assignment.attempt.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="reserved"
mkdir -- {quoted}
```
<If condition={reserved.exitCode !== 0}><Fail message="The API attempt already exists or could not be reserved. Preserve it; do not repeat the prompt." /></If>
<Dir path={assignment.attempt}><File path="assignment.json"><Json value={assignment} /></File></Dir>
<Dir path={assignment.repository}>
<Adversarial.PlannerRole assignment={assignment} guide={props.guide} as="raw" />
</Dir>
<Dir path={assignment.attempt}><File path="raw.txt">{raw}</File></Dir>
<Adversarial.Response assignment={assignment} raw={raw} as="accepted" />
<Let as="result" value={accepted.result} />
<Dir path={assignment.attempt}><File path="response-acceptance.json"><Json value={{round:accepted.round,raw:accepted.rawPath}} /></File></Dir>
<Dir path={assignment.attempt}><File path="result.json"><Json value={result} /></File></Dir>
<Let as="validated" value={null} />
<If condition={result.outcome === "complete"}>
<Adversarial.Validate assignment={assignment} result={result} as="validated" />
<Dir path={assignment.attempt}><File path="validation.json"><Json value={validated} /></File></Dir>
</If>
<Return value={{result,validated,path:assignment.attempt + "/result.json"}} />
