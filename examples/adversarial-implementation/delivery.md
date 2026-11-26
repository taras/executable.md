---
props:
  type: object
  properties:
    record: {type: string, minLength: 1}
    number: {type: integer, minimum: 1}
    action: {enum: [status, review, reconcile, publish-review, closeout], default: status}
  required: [record, number]
  additionalProperties: false
---

Read the original delivery record and perform only its computed next action.
A status read starts no agent. An explicit progress reply gets one continuation
in the same conversation. An unavailable Fable reviewer is replaced once by
Codex Astra. The workflow preserves each attempt and asks about a review it
cannot complete. Delivery publishes joined verdicts as pull request comments.
`publish-review` retries publication from the saved receipt. Readiness permits no merge.

<Ticket.Text path={props.record} as="recordText" />
<Parse schema={{type:"object",properties:{work:{type:"string"},repository:{type:"string",pattern:"^/"},directory:{type:"string",pattern:"^/"},policy:{type:"object"},required:{const:["independent-review","required-ci","main-health"]}},required:["work","repository","directory","policy","required"]}} as="delivery">{recordText}</Parse>
<Delivery.Status delivery={delivery} number={props.number} as="status" />
<Let as="publicationReview" value={null} />
<If condition={props.action === "review"}>
  <If condition={!["review","resolve_review_hold"].includes(status.nextAction)}><Fail message={"The next action is " + status.nextAction + "; do not start another review."} /></If>
  <Delivery.Review delivery={delivery} revision={status.revision} as="receipt" />
  <Let as="publicationReview" value={receipt.result === undefined ? receipt.receipt ?? null : receipt} />
</If>
<If condition={props.action === "reconcile"}>
  <If condition={!["reconciliation_required","review_held"].includes(status.status)}><Fail message="Reconciliation requires an existing incomplete or held review on the current feedback revision." /></If>
  <Delivery.Reconcile delivery={delivery} revision={status.revision} publish={true} as="publicationReview" />
</If>
<If condition={props.action === "publish-review"}>
  <If condition={status.nextAction !== "publish_review" && status.reviewPublication?.state !== "verified"}>
    <Fail message="Publication requires a validated review receipt for the current pull request head." />
  </If>
  <Let as="publicationReview" value={status.nextAction === "publish_review" ? status.review : null} />
</If>
<Let as="publication" value={null} />
<If condition={publicationReview !== null}>
  <Delivery.ReviewPublication target={{directory:delivery.directory,repository:delivery.policy.repository,number:props.number,branch:status.remote.branch,revision:status.revision}} review={publicationReview} publish={true} as="publication" />
</If>
<If condition={props.action === "review" || props.action === "reconcile" || publication !== null}>
  <Delivery.Status delivery={delivery} number={props.number} as="status" />
  <If condition={status.reviewPublication?.state === "pending" && publication?.state === "pending"}><Let as="status" value={{...status,reviewPublication:publication}} /></If>
</If>
<If condition={props.action === "closeout"}>
  <Delivery.Closeout delivery={delivery} number={props.number} as="status" />
</If>
<Dir path={delivery.directory}><File path="status.json"><Json value={status} /></File></Dir>
<Output><Json value={status} /></Output>
