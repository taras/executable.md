---
description: 'Join the required independent review, replacing an unavailable Fable reviewer once with Codex Astra. Use <Delivery.Review delivery={delivery} revision={revision} as="receipt" />.'
props:
  type: object
  properties:
    delivery: {type: object}
    revision: {type: string, pattern: '^[0-9a-f]{40}$'}
  required: [delivery, revision]
  additionalProperties: false
returns: {type: object}
---

The selection is retained before any reviewer starts. A Fable attempt that
proves it is unavailable, refused before its turn, or failed without review
output, and whose provider closed normally, selects the one Astra replacement.
An uncertain, partial or substantive attempt never does. When no reviewer can
complete, the hold is written first and the person is asked for the next
supported step.

<Delivery.Attempts delivery={props.delivery} revision={props.revision} as="read" />
<Let as="continuing" value={read.occupied} />
<If condition={!read.occupied}>
<Let as="quoted" value={"'" + read.directory.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="reserved"
mkdir -- {quoted}
```
<If condition={reserved.exitCode !== 0}><Fail message="The review attempt already exists or cannot be reserved. Reconcile its original invocation and public effects before another call." /></If>
<Dir path={read.directory}><File path="selection.json"><Json value={read.selection} /></File></Dir>
<Delivery.Dispatch delivery={props.delivery} selection={read.selection} position={0} attempt={read.directory} />
<Delivery.Attempts delivery={props.delivery} revision={props.revision} as="read" />
</If>
<If condition={continuing && read.state.next !== "replace" && !(read.state.hold !== null && read.state.hold.valid && read.state.hold.answer === null)}><Fail message="The review attempt already exists or cannot be reserved. Reconcile its original invocation and public effects before another call." /></If>
<If condition={read.state.next === "replace" && read.state.hold === null}>
<Let as="quotedReplacement" value={"'" + (read.directory + "/replacement").replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="replacementReserved"
mkdir -- {quotedReplacement}
```
<If condition={replacementReserved.exitCode !== 0}><Fail message="The replacement review is already reserved. Reconcile its original invocation before another call." /></If>
<Dir path={read.directory + "/replacement"}><File path="transition.json"><Json value={read.state.transition} /></File></Dir>
<Delivery.Dispatch delivery={props.delivery} selection={read.selection} position={1} attempt={read.directory + "/replacement"} />
<Delivery.Attempts delivery={props.delivery} revision={props.revision} as="read" />
</If>
<If condition={read.state.next === "reconcile" && read.state.hold === null}>
<Delivery.Reconcile delivery={props.delivery} revision={props.revision} publish={true} as="receipt" />
<Return value={receipt} />
<Else>
<If condition={read.selection.chain === "single"}><Fail message="Independent review did not return a joined result. Preserve this attempt and reconcile the original call; do not launch another reviewer." /></If>
<Delivery.Hold delivery={props.delivery} revision={props.revision} as="held" />
<Return value={held} />
</Else>
</If>
