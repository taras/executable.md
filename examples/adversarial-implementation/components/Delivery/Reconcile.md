---
description: 'Validate an original joined review and reconcile its receipt without prompting. Use <Delivery.Reconcile delivery={delivery} revision={revision} publish={true} as="receipt" />.'
props:
  type: object
  properties:
    delivery: {type: object}
    revision: {type: string, pattern: '^[0-9a-f]{40}$'}
    publish: {type: boolean, default: false}
  required: [delivery, revision]
  additionalProperties: false
returns: {type: object}
---

<Delivery.Schema as="schemas" />
<Let as="attempt" value={props.delivery.directory + "/review-" + props.revision} />
<Let as="assigned" value={{work:props.delivery.work,revision:props.revision,reviewer:props.delivery.policy.reviewer,acceptance:props.delivery.policy.acceptance}} />
<Ticket.Text path={attempt + "/assignment.json"} as="assignmentText" />
<Parse schema={{type:"object"}} as="assignment">{assignmentText}</Parse>
<If condition={JSON.stringify(assignment) !== JSON.stringify(assigned)}><Fail message="The original review assignment differs from the recorded delivery requirement. Reconcile it without dispatch." /></If>
<Ticket.Text path={attempt + "/execution.json"} as="executionText" />
<Parse schema={{type:"object",properties:{status:{const:"completed"},output:{type:"string"},failure:{type:"null"}},required:["status","output","failure"],additionalProperties:false}} as="execution">{executionText}</Parse>
<Parse schema={{type:"object",properties:{reply:{type:"string"}},required:["reply"],additionalProperties:false}} as="returned">{execution.output}</Parse>
<Ticket.Text path={attempt + "/raw.txt"} as="raw" />
<If condition={raw !== returned.reply}><Fail message="The saved raw reply differs from the joined execution. Preserve both for reconciliation." /></If>
<Phase.Extract text={raw} as="extracted" />
<If condition={!extracted.ok}><Fail message={extracted.rejection.message} /></If>
<Parse schema={schemas.review} as="result">{extracted.json}</Parse>
<If condition={result.revision !== props.revision || result.acceptance.length !== props.delivery.policy.acceptance.length || props.delivery.policy.acceptance.some(clause => !result.acceptance.includes(clause.id)) || result.verdict === "pass" && result.findings.some(finding => finding.blocking)}><Fail message="The joined review must cover every recorded clause on the assigned commit and cannot pass with a blocking finding." /></If>
<Let as="receipt" value={{...assigned,result,execution:attempt + "/execution.json"}} />
<Dir path={props.delivery.directory}><Glob include={["review-" + props.revision + "/receipt.json"]} as="receipts" /></Dir>
<If condition={receipts.length !== 0}>
<Ticket.Text path={attempt + "/receipt.json"} as="receiptText" />
<Parse schema={{type:"object"}} as="saved">{receiptText}</Parse>
<If condition={JSON.stringify(saved) !== JSON.stringify(receipt)}><Fail message="The receipt differs from its original joined review. Preserve it for reconciliation." /></If>
<Else>
<If condition={!props.publish}><Fail message="The joined review has no completion receipt. Use the explicit reconcile action; do not repeat the review." /></If>
</Else>
</If>
<If condition={props.publish}>
<Ticket.Checkout repository={props.delivery.repository} as="checkout" />
<If condition={checkout.head !== props.revision || !checkout.clean}><Fail message="Source changed since the review. Preserve its result; the current source needs its own evidence." /></If>
<If condition={receipts.length === 0}><Dir path={attempt}><File path="receipt.json"><Json value={receipt} /></File></Dir></If>
</If>
<Return value={receipt} />
