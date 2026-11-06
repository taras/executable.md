---
description: 'Compute the next delivery action from joined evidence. Use <Delivery.Status delivery={delivery} number={123} as="status" />.'
props:
  type: object
  properties:
    delivery: {type: object}
    number: {type: integer, minimum: 1}
  required: [delivery, number]
  additionalProperties: false
returns: {type: object}
---

A delivery amendment reservation replaces the original feedback's readiness.
Without one, the original `feedback.json` applies. With one, only the
amendment's validated final feedback selects a revision: a confirmed admission
still awaiting it is `feedback_pending`, and an incomplete or inconsistent
record holds. The reservation is observed again after the remote reads, so an
admission that appears during this status read is never ignored.

<Delivery.Schema as="schemas" />
<Let as="amendmentDirectory" value={props.delivery.directory + "/amendment"} />
<Let as="quotedAmendment" value={"'" + amendmentDirectory.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="amendmentPresent"
test -e {quotedAmendment} -o -L {quotedAmendment}
```
<Ticket.AmendmentState directory={amendmentDirectory} present={amendmentPresent.exitCode === 0} as="amendment" />
<Dir path={props.delivery.directory}><Glob include={["feedback.json"]} as="feedbackFiles" /></Dir>
<Let as="pendingGates" value={[{gate:"implementation-feedback",state:"pending"},{gate:"independent-review",state:"pending"},{gate:"required-ci",state:"pending"},{gate:"main-health",state:"pending"}]} />
<If condition={amendment.state === "hold"}>
<Return value={{work:props.delivery.work,status:"amendment_hold",nextAction:"reconcile_amendment",reason:amendment.reason,required:pendingGates,remaining:pendingGates}} />
<Else>
<If condition={amendment.state === "admitted" || amendment.state === "absent" && feedbackFiles.length === 0}>
<Return value={{work:props.delivery.work,status:"feedback_pending",nextAction:"continue_feedback",required:pendingGates,remaining:pendingGates}} />
<Else>
<Let as="feedback" value={{status:"feedback_ready",revision:amendment.revision}} />
<If condition={amendment.state === "absent"}>
<Ticket.Text path={props.delivery.directory + "/feedback.json"} as="feedbackText" />
<Parse schema={{type:"object",properties:{status:{const:"feedback_ready"},revision:{type:"string",pattern:"^[0-9a-f]{40}$"}},required:["status","revision"],additionalProperties:false}} as="feedback">{feedbackText}</Parse>
</If>
<Parse schema={schemas.policy} as="policy"><Json value={props.delivery.policy} /></Parse>
<Ticket.Checkout repository={props.delivery.repository} as="checkout" />
<Let as="revision" value={checkout.head} />
<Let as="attempt" value={props.delivery.directory + "/review-" + revision} />
<Let as="review" value={null} />
<Let as="reviewState" value="review_pending" />
<Dir path={props.delivery.directory}><Glob include={["review-" + revision + "/**"]} as="files" /></Dir>
<Let as="quotedAttempt" value={"'" + attempt.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="occupied"
test -e {quotedAttempt} -o -L {quotedAttempt}
```
<If condition={occupied.exitCode === 0}>
<Let as="reviewState" value="reconciliation_required" />
<If condition={files.includes("review-" + revision + "/receipt.json") && files.includes("review-" + revision + "/execution.json")}>
<Ticket.Capture as="reading">
<Delivery.Reconcile delivery={props.delivery} revision={revision} as="receipt" />
<Json value={receipt} />
</Ticket.Capture>
<If condition={reading.status === "completed"}>
<Parse schema={{type:"object"}} as="review">{reading.output}</Parse>
<Let as="reviewState" value={review.result.verdict === "pass" ? "passed" : review.result.verdict === "changes_required" ? "repair_required" : "blocked"} />
</If>
</If>
</If>
<Delivery.Remote repository={policy.repository} number={props.number} as="remote" />
<Ticket.Checkout repository={props.delivery.repository} as="afterRead" />
<Dir path={props.delivery.repository}>
```bash exec as="branchRead"
git symbolic-ref --quiet --short HEAD
```
</Dir>
<Let as="branch" value={branchRead.stdout.trim()} />
```bash exec as="amendmentAfter"
test -e {quotedAmendment} -o -L {quotedAmendment}
```
<Ticket.AmendmentState directory={amendmentDirectory} present={amendmentAfter.exitCode === 0} as="amendmentAgain" />

<Let as="ciPassed" value={remote.ciGreen === true && remote.ci?.status === "completed" && remote.ci?.conclusion === "success"} />
<Let as="mainPassed" value={remote.mainRepair || remote.main.run?.status === "completed" && remote.main.run?.conclusion === "success"} />
<Let as="required" value={[{gate:"independent-review",state:reviewState},{gate:"required-ci",state:ciPassed ? "passed" : remote.ci?.status === "completed" ? "failed" : "pending"},{gate:"main-health",state:mainPassed ? "passed" : remote.main.run?.status === "completed" ? "failed" : "pending"}]} />
<Let as="remaining" value={required.filter(gate => gate.state !== "passed")} />
<Let as="sourceMatches" value={checkout.clean && afterRead.clean && afterRead.head === revision && feedback.revision === revision && amendmentAgain.fingerprint === amendment.fingerprint && remote.stable && remote.revision === revision && branchRead.exitCode === 0 && remote.branch === branch && remote.base === "main"} />
<Let as="status" value={!sourceMatches ? "source_changed" : reviewState === "reconciliation_required" ? reviewState : reviewState !== "passed" ? reviewState : remaining.some(gate => gate.state === "failed") ? "checks_failed" : remaining.length !== 0 ? "checks_pending" : remote.merged && /^[0-9a-f]{40}$/.test(remote.mergeRevision) ? "delivered" : remote.state !== "open" ? "closed_unmerged" : remote.draft ? "publication_pending" : "ready_for_merge"} />
<Let as="nextAction" value={status === "review_pending" ? "review" : status === "repair_required" ? "request_approved_repair" : status === "reconciliation_required" ? "reconcile_original_review" : status === "checks_pending" ? "wait_for_checks" : status === "checks_failed" ? "repair_failed_check" : status === "publication_pending" ? "finish_pr_metadata" : status === "ready_for_merge" ? "await_authorized_merge" : status === "delivered" ? "report_delivery" : status === "blocked" ? "report_review_blocker" : "reconcile_source"} />
<Return value={{work:props.delivery.work,revision,status,nextAction,amendment:amendment.state === "absent" ? null : {state:amendment.state,feedback:amendment.feedback},required,remaining,review:review === null ? null : {attempt,result:review.result},remote}} />
</Else>
</If>
</Else></If>
