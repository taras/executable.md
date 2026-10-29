---
props:
  type: object
  properties:
    entry: {enum: [phase, continue]}
    value: {type: object}
    command: {type: string}
    root: {type: string}
  required: [entry, value, command, root]
  additionalProperties: false
returns: {type: object}
---

<File path="input.json"><Json value={props.value} /></File>
```bash exec as="location"
pwd -P
```
<Let as="entryArguments" value={[props.root + "/examples/adversarial-implementation/" + props.entry + ".md","--props-" + (props.entry === "phase" ? "request" : "record"),location.stdout.trim() + "/input.json","--raw","--include",props.root + "/examples/adversarial-implementation/tests/components","--include",props.root + "/examples/adversarial-implementation/components"].map(value => "'" + value.replaceAll("'","'\"'\"'") + "'").join(" ")} />
```bash exec as="child"
{props.command} {entryArguments};
```
<Return value={child} />
