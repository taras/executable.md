---
props:
  type: object
  properties:
    fixture: {type: object}
    request: {type: string}
    command: {type: string}
    root: {type: string}
    maxApiRepairs: {type: integer, default: 3}
  required: [fixture, request, command, root]
  additionalProperties: false
returns: {type: object}
---

<Dir path={props.fixture.root}><File path="case.json"><Json value={{fixture:props.fixture,request:props.request,maxApiRepairs:props.maxApiRepairs}} /></File></Dir>
<Let as="target" value={"'" + (props.root + "/examples/adversarial-implementation/tests/Run.md").replaceAll("'","'\"'\"'") + "'"} />
<Let as="input" value={"'" + (props.fixture.root + "/case.json").replaceAll("'","'\"'\"'") + "'"} />
<Let as="boundary" value={"'" + (props.root + "/examples/adversarial-implementation/tests/components").replaceAll("'","'\"'\"'") + "'"} />
<Let as="components" value={"'" + (props.root + "/examples/adversarial-implementation/components").replaceAll("'","'\"'\"'") + "'"} />
<Let as="repository" value={"'" + props.fixture.repository.replaceAll("'","'\"'\"'") + "'"} />
<Dir path={props.fixture.repository}>
```bash exec as="result"
cd -- {repository}
{props.command} {target} --props-case {input} --raw --include {boundary} --include {components}
```
</Dir>
<Return value={result} />
