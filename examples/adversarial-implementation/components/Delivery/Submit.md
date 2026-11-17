---
description: 'Submit one exact draft candidate for independent review. Use <Delivery.Submit delivery={delivery} number={123} revision={revision} as="review" />.'
props:
  type: object
  properties:
    delivery: {type: object}
    number: {type: integer, minimum: 1}
    revision: {type: string, pattern: '^[0-9a-f]{40}$'}
  required: [delivery, number, revision]
  additionalProperties: false
returns: {type: object}
---

<Delivery.Pin delivery={props.delivery} number={props.number} as="admission" />
<If condition={admission.incomplete}><Fail message="The candidate admission is incomplete. Reconcile it before submitting." /></If>
<Delivery.Gates delivery={props.delivery} number={props.number} as="gates" />
<If condition={!gates.eligible || gates.source.head !== props.revision}><Fail message="Submission requires exact feedback, a clean branch, the matching open draft against main, and green required CI for the submitted SHA." /></If>
<Let as="pin" value={admission.pin} />
<If condition={pin?.revision !== props.revision}>
<Let as="repair" value={null} />
<If condition={pin === null}>
<Delivery.Legacy delivery={props.delivery} as="legacy" />
<If condition={legacy.length !== 0 && !legacy.includes(props.revision)}><Fail message="Recover the original attempt before admitting a different SHA." /></If>
<Else>
<If condition={admission.seen.includes(props.revision) || pin.branch !== gates.source.branch}><Fail message="The repair requires a new revision on the admitted branch." /></If>
<Delivery.Status delivery={props.delivery} number={props.number} revision={pin.revision} as="previous" />
<If condition={previous.review?.result.verdict !== "changes_required" || previous.reviewPublication?.state !== "verified"}><Fail message={"Keep the submission on " + pin.revision + ". Restore that revision for publication or reconcile its original attempt before submitting a repair."} /></If>
<Let as="repair" value={previous.reviewPublication} />
</Else>
</If>
<Let as="quoted" value={"'" + admission.slot.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="reserved"
mkdir -- {quoted}
```
<If condition={reserved.exitCode !== 0}><Fail message="The candidate slot is already reserved or unavailable. Read status before retrying." /></If>
<Let as="pin" value={{schema:"delivery-candidate.v1",work:props.delivery.work,repository:props.delivery.policy.repository,checkout:props.delivery.repository,number:props.number,revision:props.revision,branch:gates.source.branch,previous:pin?.revision ?? null,feedback:{path:props.delivery.directory + "/feedback.json",...gates.feedback},ci:{...gates.remote.ci,green:gates.remote.ciGreen},repair}} />
<Dir path={admission.slot}><File path="admission.json"><Json value={pin} /></File></Dir>
</If>
<Delivery.Gates delivery={props.delivery} number={props.number} as="fresh" />
<If condition={!fresh.eligible || fresh.source.head !== pin.revision || fresh.source.branch !== pin.branch}><Fail message={"Admission is pinned to " + pin.revision + ". Restore its exact source and green CI before dispatch."} /></If>

<Delivery.Attempts delivery={props.delivery} revision={pin.revision} as="attempt" />
<If condition={!attempt.occupied || attempt.state.next === "replace" && attempt.state.hold === null}>
<Ticket.Capture as="execution">
<Delivery.Review delivery={props.delivery} revision={pin.revision} branch={pin.branch} as="receipt" />
<Json value={receipt.result === undefined ? receipt.receipt ?? null : receipt} />
</Ticket.Capture>
<If condition={execution.status === "completed"}>
<Parse schema={{type:["object","null"]}} as="receipt">{execution.output}</Parse>
<Return value={{receipt}} />
<Else>
<Delivery.Source repository={props.delivery.repository} as="after" />
<If condition={after.clean && after.head === pin.revision && after.branch === pin.branch}><Fail message={execution.failure} /></If>
<Return value={{receipt:null}} />
</Else>
</If>
<Else>
<If condition={attempt.state.next === "reconcile" && attempt.state.hold === null}>
<Delivery.Reconcile delivery={props.delivery} revision={pin.revision} publish={true} as="receipt" />
<Return value={{receipt}} />
<Else>
<Fail message={"The review on " + pin.revision + " is already reserved. Reconcile its original invocation; do not start another review."} />
</Else>
</If>
</Else>
</If>
