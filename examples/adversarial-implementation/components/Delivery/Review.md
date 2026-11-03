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

<Let as="attempt" value={props.delivery.directory + "/review-" + props.revision} />
<Let as="quoted" value={"'" + attempt.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="reserved"
mkdir -- {quoted}
```
<If condition={reserved.exitCode !== 0}><Fail message="The review attempt already exists or cannot be reserved. Reconcile its original invocation and public effects before another call." /></If>
<Dir path={attempt}><File path="assignment.json"><Json value={{work:props.delivery.work,revision:props.revision,reviewer:props.delivery.policy.reviewer,acceptance:props.delivery.policy.acceptance}} /></File></Dir>
<Ticket.Capture as="execution"><Delivery.Role delivery={props.delivery} revision={props.revision} as="reply" /><Json value={{reply}} /></Ticket.Capture>
<Dir path={attempt}><File path="execution.json"><Json value={execution} /></File></Dir>
<If condition={execution.status !== "completed"}><Fail message="Independent review did not return a joined result. Preserve this attempt and reconcile the original call; do not launch another reviewer." /></If>
<Parse schema={{type:"object",properties:{reply:{type:"string"}},required:["reply"],additionalProperties:false}} as="returned">{execution.output}</Parse>
<Dir path={attempt}><File path="raw.txt">{returned.reply}</File></Dir>
<Phase.Extract text={returned.reply} as="extracted" />
<If condition={!extracted.ok}><Fail message={extracted.rejection.message} /></If>
<Delivery.Schema as="schemas" />
<Parse schema={schemas.review} as="result">{extracted.json}</Parse>
<If condition={result.revision !== props.revision || result.acceptance.length !== props.delivery.policy.acceptance.length || props.delivery.policy.acceptance.some(clause => !result.acceptance.includes(clause.id)) || result.verdict === "pass" && result.findings.some(finding => finding.blocking)}><Fail message="The joined review must cover every recorded clause on the assigned commit and cannot pass with a blocking finding. Preserve the raw reply for reconciliation." /></If>
<Ticket.Checkout repository={props.delivery.repository} as="checkout" />
<If condition={checkout.head !== props.revision || !checkout.clean}><Fail message="Source changed during independent review. Preserve its result; the new source needs its own evidence." /></If>
<Let as="receipt" value={{work:props.delivery.work,revision:props.revision,reviewer:props.delivery.policy.reviewer,acceptance:props.delivery.policy.acceptance,result,execution:attempt + "/execution.json"}} />
<Dir path={attempt}><File path="receipt.json"><Json value={receipt} /></File></Dir>
<Return value={receipt} />
