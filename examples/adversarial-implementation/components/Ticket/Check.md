---
description: >-
  Require the recorded clean HEAD before dispatch.
  Use <Ticket.Check record={record} as="facts" />.
props:
  type: object
  properties:
    record: {type: object}
    beforeDispatch: {type: boolean, default: true}
  required: [record]
  additionalProperties: false
returns: {type: object}
---

<Let as="checkout" value={null} />
<If condition={props.beforeDispatch}>
<Ticket.Checkout repository={props.record.manifest.assignment.repository} as="checkout" />
<If condition={checkout.head !== props.record.checkpoint.revision || !checkout.clean}>
<Fail message="HEAD or tracked source changed outside the recorded feedback transition. Reconcile before dispatch." />
</If>
</If>
<Return value={{checkout}} />
