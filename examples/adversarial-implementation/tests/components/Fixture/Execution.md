---
props:
  type: object
  properties:
    entry: {enum: [run, continue, resolve-decision]}
    value: {type: object}
    repository: {type: string}
    root: {type: string}
    steps: {type: integer, minimum: 1}
    decision: {type: string}
  required: [entry, value, repository, root]
  additionalProperties: false
returns: {type: object}
---

<File path="input.json"><Json value={props.value} /></File>
```bash exec as="location"
pwd -P
```
<Let as="input" value={location.stdout.trim() + "/input.json"} />
<Let as="receipt">
<Dir path={props.repository}>
<Execution host="run" target={props.root + "/examples/adversarial-implementation/" + props.entry + ".md"} props={props.entry === "run" ? {task:input} : props.entry === "resolve-decision" ? {record:input,decision:props.decision} : {record:input,steps:props.steps ?? 1}}>
<CollectOutput as="stdout" />
<Json value={{exitCode:0,stdout,stderr:""}} />
</Execution>
</Dir>
</Let>
<Parse schema={{type:"object"}} as="child">{receipt}</Parse>
<Return value={child} />
