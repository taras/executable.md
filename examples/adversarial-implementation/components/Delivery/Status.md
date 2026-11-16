---
description: 'Compute the next delivery action from joined evidence. Use <Delivery.Status delivery={delivery} number={123} as="status" />.'
props:
  type: object
  properties:
    delivery: {type: object}
    number: {type: integer, minimum: 1}
    revision: {type: string, pattern: '^[0-9a-f]{40}$'}
  required: [delivery, number]
  additionalProperties: false
returns: {type: object}
---

<Delivery.Pin delivery={props.delivery} number={props.number} as="admission" />
<Delivery.Legacy delivery={props.delivery} as="legacy" />
<Let as="pin" value={admission.pin} />
<Let as="revision" value={props.revision ?? pin?.revision ?? (legacy.length === 1 ? legacy[0] : null)} />
<Let as="submitted" value={revision !== null && admission.seen.includes(revision)} />
<If condition={props.revision !== undefined && !submitted && !legacy.includes(props.revision)}><Fail message="The requested revision does not identify a retained attempt for this delivery." /></If>
<Dir path={props.delivery.directory}><Glob include={["feedback.json"]} as="feedbackFiles" /></Dir>
<If condition={revision === null && feedbackFiles.length === 0 && !admission.incomplete && legacy.length === 0}>
<Let as="required" value={["implementation-feedback","independent-review","required-ci","main-health"].map(gate => ({gate,state:"pending"}))} />
<Return value={{work:props.delivery.work,status:"feedback_pending",nextAction:"continue_feedback",pin,legacy,required,remaining:required}} />
<Else>
<Delivery.Gates delivery={props.delivery} number={props.number} as="gates" />
<Let as="remote" value={gates.remote} />
<Let as="source" value={gates.source} />
<Let as="branch" value={submitted ? pin.branch : remote.branch} />
<Let as="review" value={null} />
<Let as="reviewState" value="review_pending" />
<Let as="selected" value={null} />
<Let as="sourceEvidence" value={[]} />
<If condition={revision !== null}>
<Delivery.Attempts delivery={props.delivery} revision={revision} as="selected" />
<Let as="attempt" value={selected.state.effective?.directory ?? selected.directory} />
<If condition={selected.occupied}>
<Dir path={attempt}><Glob include={["source-before.json","source-after.json"]} as="observations" /></Dir>
<Let as="sourceEvidence" value={observations.map(file => attempt + "/" + file)} />
<Let as="reviewState" value="reconciliation_required" />
<If condition={selected.state.effective !== null}>
<Dir path={attempt}><Glob include={["receipt.json","execution.json"]} as="files" /></Dir>
<If condition={files.length === 2}>
<Ticket.Capture as="reading">
<Delivery.Reconcile delivery={props.delivery} revision={revision} as="receipt" />
<Json value={receipt} />
</Ticket.Capture>
<If condition={reading.status === "completed"}>
<Parse schema={{type:"object"}} as="receipt">{reading.output}</Parse>
<Let as="review" value={{attempt,result:receipt.result,reviewer:receipt.reviewer,model:receipt.model}} />
<Let as="reviewState" value={review.result.verdict === "pass" ? "passed" : review.result.verdict === "changes_required" ? "repair_required" : "blocked"} />
</If>
</If>
</If>
<If condition={reviewState === "reconciliation_required" && selected.state.hold !== null && selected.state.hold.valid}><Let as="reviewState" value="review_held" /></If>
<If condition={reviewState === "reconciliation_required" && selected.state.next === "replace" && selected.state.hold === null}><Let as="reviewState" value="review_pending" /></If>
</If>
</If>

<Let as="sourceMatches" value={gates.sourceMatches && (revision === null || revision === source.head && branch === source.branch)} />
<Let as="reviewPublication" value={null} />
<If condition={review !== null}>
<Delivery.ReviewPublication target={{directory:props.delivery.directory,repository:props.delivery.policy.repository,number:props.number,branch,revision}} review={review} publish={false} as="reviewPublication" />
</If>
<Delivery.Source repository={props.delivery.repository} as="after" />
<Let as="sourceMatches" value={sourceMatches && after.clean && after.head === source.head && after.branch === source.branch} />
<Let as="publicationPending" value={review !== null && reviewPublication?.state !== "verified"} />
<Let as="required" value={[{gate:"independent-review",state:publicationPending ? "publication_pending" : reviewState},{gate:"required-ci",state:gates.ciPassed ? "passed" : remote.ci?.status === "completed" ? "failed" : "pending"},{gate:"main-health",state:gates.mainPassed ? "passed" : remote.main.run?.status === "completed" ? "failed" : "pending"}]} />
<Let as="remaining" value={required.filter(gate => gate.state !== "passed")} />
<Let as="decision" value={null} />
<If condition={admission.incomplete}><Let as="decision" value={["reconciliation_required","reconcile_admission"]} /></If>
<If condition={decision === null && revision === null && legacy.length > 1}><Let as="decision" value={["reconciliation_required","select_original_review"]} /></If>
<If condition={decision === null && !sourceMatches}>
<Let as="decision" value={["source_changed",reviewState === "repair_required" && !publicationPending && pin !== null ? "request_approved_repair" : reviewState === "reconciliation_required" ? "reconcile_original_review" : reviewState === "review_held" ? (selected.state.hold.answer === null ? "resolve_review_hold" : "report_review_hold") : pin !== null || revision !== null ? "restore_submitted_revision" : "reconcile_source"]} />
</If>
<If condition={decision === null && publicationPending}><Let as="decision" value={["publication_pending","publish_review"]} /></If>
<If condition={decision === null && reviewState === "review_held"}><Let as="decision" value={[reviewState,selected.state.hold.answer === null ? "resolve_review_hold" : "report_review_hold"]} /></If>
<If condition={decision === null && reviewState === "reconciliation_required"}><Let as="decision" value={[reviewState,"reconcile_original_review"]} /></If>
<If condition={decision === null && reviewState === "repair_required"}><Let as="decision" value={[reviewState,"request_approved_repair"]} /></If>
<If condition={decision === null && reviewState === "blocked"}><Let as="decision" value={[reviewState,"report_review_blocker"]} /></If>
<If condition={decision === null && reviewState === "passed" && remote.state !== "open"}>
<Let as="decision" value={remote.merged && /^[0-9a-f]{40}$/.test(remote.mergeRevision) && remaining.length === 0 ? ["delivered","report_delivery"] : ["closed_unmerged","reconcile_source"]} />
</If>
<If condition={decision === null && reviewState === "review_pending" && gates.feedback?.revision !== source.head}><Let as="decision" value={["feedback_pending","continue_feedback"]} /></If>
<If condition={decision === null && (!gates.ciPassed || reviewState === "passed" && !gates.mainPassed)}>
<Let as="checkFailed" value={!gates.ciPassed && remote.ci?.status === "completed" || reviewState === "passed" && !gates.mainPassed && remote.main.run?.status === "completed"} />
<Let as="decision" value={checkFailed ? ["checks_failed","repair_failed_check"] : ["checks_pending","wait_for_checks"]} />
</If>
<If condition={decision === null && reviewState === "passed"}>
<Let as="decision" value={!remote.draft ? ["ready_for_merge","await_authorized_merge"] : pin === null ? ["review_pending","submit"] : ["ready_pending","mark_ready_manually"]} />
</If>
<Let as="status" value={decision?.[0] ?? reviewState} />
<Let as="nextAction" value={decision?.[1] ?? (gates.eligible ? "submit" : "reconcile_source")} />
<Return value={{work:props.delivery.work,revision,pin,submitted,legacy,branch,local:after,status,nextAction,required,remaining,review,reviewPublication,reviewAttempts:selected?.occupied ? {chain:selected.state.chain,selection:selected.state.selection,attempts:selected.state.attempts,effective:selected.state.effective,hold:selected.state.hold,sourceEvidence} : null,remote}} />
</Else>
</If>
