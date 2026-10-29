---
props:
  type: object
  properties:
    record: {type: string, minLength: 1}
    steps: {type: integer, minimum: 1, default: 1}
  required: [record]
  additionalProperties: false
---

<Ticket.Text path={props.record} as="text" />
<Parse schema={{type:"object",properties:{manifest:{type:"object"},checkpoint:{type:"object",properties:{dispatchable:{type:"boolean"}},required:["dispatchable"]},calls:{type:"array"},documents:{type:"object"}},required:["manifest","checkpoint","calls","documents"]}} as="record">{text}</Parse>
<Ticket.Continue record={record} maxSteps={props.steps} as="continued" />
<Output><Json value={continued} /></Output>
