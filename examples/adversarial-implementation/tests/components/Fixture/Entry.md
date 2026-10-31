---
props:
  type: object
  properties:
    entry: {enum: [phase, continue, run]}
    value: {type: object}
    raw: {type: string}
    taskPath: {type: [string, 'null'], default: null}
    steps: {type: integer, minimum: 1}
    repository: {type: string}
    command: {type: string}
    root: {type: string}
  required: [entry, value, command, root]
  additionalProperties: false
returns: {type: object}
---

<Let as="inputText" value={props.raw ?? JSON.stringify(props.value)} />
<File path="input.json">{inputText}</File>
```bash exec as="location"
pwd -P
```
<Let as="entryArguments" value={[props.root + "/examples/adversarial-implementation/" + props.entry + ".md","--props-" + (props.entry === "phase" ? "request" : props.entry === "run" ? "task" : "record"),props.taskPath ?? location.stdout.trim() + "/input.json",...(props.steps === undefined ? [] : ["--props-steps",String(props.steps)]),"--raw","--include",props.root + "/examples/adversarial-implementation/tests/components","--include",props.root + "/examples/adversarial-implementation/components"].map(value => "'" + value.replaceAll("'","'\"'\"'") + "'").join(" ")} />
<Let as="directory" value={"'" + (props.repository ?? (props.entry === "run" ? props.value.repository : location.stdout.trim())).replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="child"
set -e
cd -- {directory}
{props.command} {entryArguments};
```
<Return value={child} />
