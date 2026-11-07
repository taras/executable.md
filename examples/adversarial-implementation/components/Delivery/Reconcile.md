---
description: 'Validate the selected joined review and reconcile its receipt without prompting. Use <Delivery.Reconcile delivery={delivery} revision={revision} publish={true} as="receipt" />.'
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

Only the retained selection's attempt can supply the receipt: the original
reviewer, or its replacement after a retained transition from an eligible
failure. A joined execution whose raw reply was never saved is completed from
that execution.

<Delivery.Schema as="schemas" />
<Delivery.Attempts delivery={props.delivery} revision={props.revision} as="read" />
<If condition={read.state.candidate === null}><Fail message={"No selected review attempt can supply a receipt (" + read.state.selection + " selection). Preserve the retained attempts; this reconciliation action starts no provider prompt."} /></If>
<Let as="attempt" value={read.state.candidate.directory} />
<Let as="assigned" value={{work:props.delivery.work,revision:props.revision,reviewer:read.state.candidate.reviewer,acceptance:props.delivery.policy.acceptance,responseSchema:schemas.review}} />
<Ticket.Text path={attempt + "/assignment.json"} as="assignmentText" />
<Parse schema={{type:"object"}} as="assignment">{assignmentText}</Parse>
<If condition={JSON.stringify(assignment) !== JSON.stringify(assigned)}><Fail message="The original review assignment or response schema differs from the recorded delivery requirement. Preserve the original rejection; schema changes require an explicit applicable amendment decision outside this action. This reconciliation action starts no provider prompt." /></If>
<If condition={read.state.effective === null}><Fail message={"The selected review attempt has no joined review reply: " + read.state.attempts[read.state.candidate.position].reason + " This reconciliation action starts no provider prompt."} /></If>
<Ticket.Text path={attempt + "/execution.json"} as="executionText" />
<Parse schema={{type:"object",properties:{status:{const:"completed"},output:{type:"string"},failure:{type:"null"}},required:["status","output","failure"],additionalProperties:false}} as="execution">{executionText}</Parse>
<Parse schema={{type:"object",properties:{stage:{const:"settled"},turn:{type:"object",properties:{state:{const:"reply"},reply:{type:"string"}},required:["state","reply"],additionalProperties:false}},required:["stage","turn"]}} as="returned">{execution.output}</Parse>
<Dir path={attempt}><Glob include={["raw.txt","receipt.json"]} as="derived" /></Dir>
<If condition={!derived.includes("raw.txt")}>
<If condition={!props.publish}><Fail message="The joined review has no saved raw reply. Use the explicit reconcile action; do not repeat the review." /></If>
<Dir path={attempt}><File path="raw.txt">{returned.turn.reply}</File></Dir>
</If>
<Ticket.Text path={attempt + "/raw.txt"} as="raw" />
<If condition={raw !== returned.turn.reply}><Fail message="The saved raw reply differs from the joined execution. Preserve both for reconciliation." /></If>
<Phase.Extract text={raw} as="extracted" />
<If condition={!extracted.ok}><Fail message={extracted.rejection.message} /></If>
<Parse schema={schemas.review} as="result">{extracted.json}</Parse>
<If condition={result.revision !== props.revision || result.acceptance.length !== props.delivery.policy.acceptance.length || props.delivery.policy.acceptance.some(clause => !result.acceptance.includes(clause.id)) || result.verdict === "pass" && result.findings.some(finding => finding.blocking)}><Fail message="The joined review must cover every recorded clause on the assigned commit and cannot pass with a blocking finding." /></If>
<Let as="receipt" value={{...assigned,result,execution:attempt + "/execution.json"}} />
<If condition={derived.includes("receipt.json")}>
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
<If condition={!derived.includes("receipt.json")}><Dir path={attempt}><File path="receipt.json"><Json value={receipt} /></File></Dir></If>
</If>
<Return value={receipt} />
