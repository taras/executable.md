---
description: 'Join the required independent review once. Use <Delivery.Review delivery={delivery} revision={revision} as="receipt" />.'
props:
  type: object
  properties:
    delivery: {type: object}
    revision: {type: string, pattern: '^[0-9a-f]{40}$'}
  required: [delivery, revision]
  additionalProperties: false
returns: {type: object}
---

<Delivery.Schema as="schemas" />
<Let as="attempt" value={props.delivery.directory + "/review-" + props.revision} />
<Let as="quoted" value={"'" + attempt.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="reserved"
mkdir -- {quoted}
```
<If condition={reserved.exitCode !== 0}><Fail message="The review attempt already exists or cannot be reserved. Reconcile its original invocation and public effects before another call." /></If>
<Dir path={attempt}><File path="assignment.json"><Json value={{work:props.delivery.work,revision:props.revision,reviewer:props.delivery.policy.reviewer,acceptance:props.delivery.policy.acceptance,responseSchema:schemas.review}} /></File></Dir>
<Ticket.Capture as="execution"><Delivery.Role delivery={props.delivery} revision={props.revision} as="reply" /><Json value={{reply}} /></Ticket.Capture>
<Dir path={attempt}><File path="execution.json"><Json value={execution} /></File></Dir>
<If condition={execution.status !== "completed"}><Fail message="Independent review did not return a joined result. Preserve this attempt and reconcile the original call; do not launch another reviewer." /></If>
<Parse schema={{type:"object",properties:{reply:{type:"string"}},required:["reply"],additionalProperties:false}} as="returned">{execution.output}</Parse>
<Dir path={attempt}><File path="raw.txt">{returned.reply}</File></Dir>
<Delivery.Reconcile delivery={props.delivery} revision={props.revision} publish={true} as="receipt" />
<Return value={receipt} />
