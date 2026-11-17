---
description: 'Read the admitted candidate and its successor slot. Use <Delivery.Pin delivery={delivery} number={123} as="admission" />.'
props:
  type: object
  properties:
    delivery: {type: object}
    number: {type: integer, minimum: 1}
  required: [delivery, number]
  additionalProperties: false
returns: {type: object}
---

<Let as="prefix" value={"candidate-" + props.number + "-"} />
<Dir path={props.delivery.directory}><Glob include={[prefix + "*/admission.json"]} as="records" /></Dir>
<Let as="pin" value={null} />
<Let as="seen" value={[]} />
<Let as="index" value={1} />
<Let as="schema" value={{type:"object",properties:{schema:{const:"delivery-candidate.v1"},work:{const:props.delivery.work},repository:{const:props.delivery.policy.repository},checkout:{const:props.delivery.repository},number:{const:props.number},revision:{type:"string",pattern:"^[0-9a-f]{40}$"},branch:{type:"string",minLength:1},previous:{type:["string","null"]},feedback:{type:"object"},ci:{type:"object"},repair:{type:["object","null"]}},required:["schema","work","repository","checkout","number","revision","branch","previous","feedback","ci","repair"],additionalProperties:false}} />
<Let as="invalid" value={false} />
<If condition={records.length !== 0}>
<Loop max={records.length}>
<Let as="expected" value={prefix + index + "/admission.json"} />
<If condition={!invalid && records.includes(expected)}>
<Ticket.Text path={props.delivery.directory + "/" + expected} as="text" />
<SafeParse schema={schema} as="read">{text}</SafeParse>
<If condition={read.ok && read.value.previous === (pin?.revision ?? null) && !seen.includes(read.value.revision)}>
<Let as="pin" value={read.value} />
<Let as="seen" value={[...seen,pin.revision]} />
<Let as="index" value={index + 1} />
<Else>
<Let as="invalid" value={true} />
</Else>
</If>
<Else>
<Let as="invalid" value={true} />
</Else>
</If>
</Loop>
</If>
<Let as="slot" value={props.delivery.directory + "/" + prefix + index} />
<Let as="quoted" value={"'" + slot.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="occupied"
test -e {quoted} -o -L {quoted}
```
<Return value={{pin,slot,incomplete:invalid || occupied.exitCode === 0,seen}} />
