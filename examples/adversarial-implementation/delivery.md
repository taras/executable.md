---
props:
  type: object
  properties:
    record: {type: string, minLength: 1}
    number: {type: integer, minimum: 1}
    action: {enum: [status, submit, review, reconcile, publish-review, ready, closeout], default: status}
    revision: {type: string, pattern: '^[0-9a-f]{40}$'}
  required: [record, number]
  additionalProperties: false
---

Submit the exact draft candidate after internal feedback and green required CI.
Status reads the pinned review and current heads. Recovery reads the original
attempt. Ready verifies the passing review, comment and current checks and
reports the exact draft revision for the maintainer to mark ready.

<Ticket.Text path={props.record} as="recordText" />
<Parse schema={{type:"object",properties:{work:{type:"string"},repository:{type:"string",pattern:"^/"},directory:{type:"string",pattern:"^/"},policy:{type:"object"},required:{const:["independent-review","required-ci","main-health"]}},required:["work","repository","directory","policy","required"]}} as="delivery">{recordText}</Parse>
<If condition={props.action === "submit" && props.revision === undefined}><Fail message="Submit requires --props-revision with the full candidate SHA." /></If>
<If condition={props.revision !== undefined && !["submit","review","reconcile","publish-review"].includes(props.action)}><Fail message="Revision is available for submission and recovery actions." /></If>
<Let as="status" value={null} />
<If condition={props.action === "ready"}>
<Delivery.Ready delivery={delivery} number={props.number} as="status" />
<Else>
<Let as="publicationReview" value={null} />
<If condition={props.action === "submit"}>
<Delivery.Submit delivery={delivery} number={props.number} revision={props.revision} as="submitted" />
<Let as="publicationReview" value={submitted.receipt} />
</If>
<Let as="recoveryRevision" value={props.action === "submit" ? undefined : props.revision} />
<Delivery.Status delivery={delivery} number={props.number} revision={recoveryRevision} as="status" />
<If condition={props.action === "review"}>
<If condition={status.nextAction !== "resolve_review_hold"}><Fail message={"The next action is " + status.nextAction + "; do not start another review."} /></If>
<Delivery.Hold delivery={delivery} revision={status.revision} as="held" />
<Let as="publicationReview" value={held.receipt ?? null} />
</If>
<If condition={props.action === "reconcile"}>
<If condition={status.reviewAttempts == null}><Fail message="Reconciliation requires an existing attempt. Supply its original revision when there is more than one." /></If>
<Delivery.Reconcile delivery={delivery} revision={status.revision} publish={true} as="publicationReview" />
</If>
<If condition={props.action === "publish-review"}>
<If condition={status.review == null}><Fail message="Publication requires a validated review receipt for the original pull request head." /></If>
<Let as="publicationReview" value={status.reviewPublication?.state === "verified" ? null : status.review} />
</If>
<Let as="publication" value={null} />
<If condition={publicationReview !== null && status.revision === publicationReview.result.revision && (status.submitted || status.local?.head === status.revision && status.local?.clean && status.local?.branch === status.branch)}>
<Delivery.ReviewPublication target={{directory:delivery.directory,repository:delivery.policy.repository,number:props.number,branch:status.branch,revision:status.revision}} review={publicationReview} publish={true} as="publication" />
</If>
<If condition={["review","reconcile"].includes(props.action) || publication !== null}>
<Delivery.Status delivery={delivery} number={props.number} revision={recoveryRevision} as="status" />
<If condition={status.reviewPublication?.state === "pending" && publication?.state === "pending"}><Let as="status" value={{...status,reviewPublication:publication}} /></If>
</If>
<If condition={props.action === "closeout"}>
<Delivery.Closeout delivery={delivery} number={props.number} as="status" />
</If>
</Else>
</If>
<Dir path={delivery.directory}><File path="status.json"><Json value={status} /></File></Dir>
<Output><Json value={status} /></Output>
