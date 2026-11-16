---
description: 'Find original attempts available for recovery. Use <Delivery.Legacy delivery={delivery} as="revisions" />.'
props:
  type: object
  properties:
    delivery: {type: object}
  required: [delivery]
  additionalProperties: false
returns: {type: array}
---

<Dir path={props.delivery.directory}>
```bash exec as="listing"
printf '%s\n' review-*
```
</Dir>
<If condition={listing.exitCode !== 0}><Fail message="Could not list retained review attempts." /></If>
<Return value={listing.stdout.trim().split("\n").filter(path => /^review-[0-9a-f]{40}$/.test(path)).map(path => path.slice(7))} />
