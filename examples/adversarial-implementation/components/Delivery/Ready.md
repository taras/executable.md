---
description: 'Verify the exact reviewed draft for maintainer readiness. Use <Delivery.Ready delivery={delivery} number={123} as="status" />.'
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
<Return value={status} />
