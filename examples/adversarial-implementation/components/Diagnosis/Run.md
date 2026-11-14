---
description: 'Run a recorded problem-solver assignment. Use <Diagnosis.Run request={request} solvers={solvers} as="diagnosis" />.'
props:
  type: object
  properties:
    request: {type: object}
    solvers: {type: object}
  required: [request, solvers]
  additionalProperties: false
returns: {type: object}
---

<Diagnosis.Schema as="schema" />
<Parse schema={schema.request} as="request"><Json value={props.request} /></Parse>
<Parse schema={schema.solvers} as="solvers"><Json value={props.solvers} /></Parse>
<If condition={request.assignment.kind === "design"}>
<Diagnosis.Workflow request={request} solvers={solvers} contract={schema.design} as="result">
<Diagnosis.DesignMaterial assignment={assignment} resultSchema={schema.design.reply.schema} />
<Diagnosis.DesignContext slot="continuation" assignment={assignment} previous={priorAssignment} />
<Diagnosis.DesignContext slot="evidence" assignment={assignment} inputs={inputs} />
</Diagnosis.Workflow>
<Return value={result} />
<Else>
<Diagnosis.Workflow request={request} solvers={solvers} contract={schema.diagnosis} as="result">
<Diagnosis.FailureMaterial assignment={assignment} resultSchema={schema.diagnosis.reply.schema} />
<Diagnosis.FailureContinuation slot="continuation" assignment={assignment} previous={priorAssignment} />
</Diagnosis.Workflow>
<Return value={result} />
</Else>
</If>
