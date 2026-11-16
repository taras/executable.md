---
description: 'Mark the exact reviewed draft ready. Use <Delivery.Ready delivery={delivery} number={123} as="status" />.'
props:
  type: object
  properties:
    delivery: {type: object}
    number: {type: integer, minimum: 1}
  required: [delivery, number]
  additionalProperties: false
returns: {type: object}
---

<Delivery.Status delivery={props.delivery} number={props.number} as="status" />
<If condition={status.pin === null || !["ready_pending","ready_for_merge"].includes(status.status) || status.reviewPublication?.state !== "verified"}><Fail message={"Readiness requires the submitted PASS and verified comment. Next action is " + status.nextAction + "."} /></If>
<Let as="pin" value={status.pin} />
<Delivery.Gates delivery={props.delivery} number={props.number} as="fresh" />
<If condition={!fresh.sourceMatches || fresh.source.head !== pin.revision || fresh.source.branch !== pin.branch || fresh.remote.state !== "open" || !fresh.ciPassed || !fresh.mainPassed}><Fail message={"Readiness evidence changed for " + pin.revision + ". Read status before another request."} /></If>
<If condition={fresh.remote.draft}>
<Parse schema={{type:"string",pattern:"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"}} as="repository"><Json value={pin.repository} /></Parse>
```bash exec as="mutation"
gh pr ready {props.number} --repo {repository}
```
</If>
<Delivery.Status delivery={props.delivery} number={props.number} as="readback" />
<If condition={readback.status !== "ready_for_merge" || readback.revision !== pin.revision || readback.reviewPublication?.state !== "verified"}><Fail message={"Readiness could not be confirmed for " + pin.revision + ". Observed local " + readback.local?.head + ", remote " + (readback.remote?.observedRevision ?? readback.remote?.revision) + " and status " + readback.status + ". " + readback.nextAction} /></If>
<Return value={readback} />
