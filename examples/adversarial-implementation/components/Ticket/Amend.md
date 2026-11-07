---
description: >-
  Admit one measured-weights delivery amendment for a completed ticket without
  starting a role. Use <Ticket.Amend record={envelope}
  grant="/absolute/grant.json" as="admitted" />.
props:
  type: object
  properties:
    record: {type: object}
    grant: {type: string, minLength: 1}
  required: [record, grant]
  additionalProperties: false
returns: {type: object}
---

The original feedback owns exactly one reservation, `delivery/amendment`. A
repeated admission returns the first confirmed disposition, and an incomplete
reservation holds. First admission evaluates the explicitly selected target
`scripts/runtime-test-exclusions.ts` through the installed module loader, only
after every grant, source, allowance and workflow check has passed, to derive
the target corpus. A disposition counts only beside the acknowledgment written
after its own write returned, so complete bytes from an unknown write still hold; neither prepares, publishes nor dispatches again. Validation
precedes the reservation, so a refusal spends nothing.

<Ticket.Load record={props.record} as="saved" />
<Let as="directory" value={saved.manifest.delivery?.directory} />
<If condition={typeof directory !== "string"}><Fail message="A delivery amendment requires the ticket's recorded delivery directory. No reservation was made." /></If>
<Let as="reservation" value={directory + "/amendment"} />
<Let as="held" value={{schema:"ticket-return.v1",work:props.record.work,source:props.record.source,status:"hold",revision:props.record.revision,publication:"held",continuation:props.record.continuation,pending:null}} />
<Let as="quotedReservation" value={"'" + reservation.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="present"
test -e {quotedReservation} -o -L {quotedReservation}
```
<If condition={present.exitCode === 0}>
<Ticket.AmendmentState directory={reservation} present={true} as="existing" />
<If condition={existing.state === "hold"}><Return value={{...held,hold:existing.reason}} /><Else><Return value={existing.envelope} /></Else></If>
<Else>
<Let as="id" value={String(saved.calls.length).padStart(4,"0")} />
<Let as="slots" value={[saved.manifest.directory + "/calls/" + id,saved.manifest.directory + "/attempts/" + id].map(path => "'" + path.replaceAll("'","'\"'\"'") + "'").join(" ")} />
```bash exec as="occupied"
for slot in {slots}; do test -e "$slot" -o -L "$slot" && exit 0; done; exit 1
```
<Ticket.Checkout repository={saved.manifest.assignment.repository} as="checkout" />
<Ticket.WorkflowSource as="workflowSource" />
<Let as="workflowQuoted" value={"'" + workflowSource.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="workflow"
git -C {workflowQuoted} rev-parse HEAD
```
<Let as="targetQuoted" value={"'" + saved.manifest.assignment.repository.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="targetTree"
git -C {targetQuoted} ls-tree {saved.checkpoint.revision} -- scripts/runtime-test-exclusions.ts
```
```bash exec as="targetBlob"
git -C {targetQuoted} hash-object -- scripts/runtime-test-exclusions.ts
```
<Ticket.AmendmentPrepare record={props.record} saved={saved} grant={props.grant} checkout={{head:checkout.head,clean:checkout.clean}} workflowRevision={workflow.exitCode === 0 ? workflow.stdout.trim() : null} occupied={occupied.exitCode === 0} targetTree={targetTree.exitCode === 0 ? targetTree.stdout : ""} targetBlob={targetBlob.exitCode === 0 ? targetBlob.stdout : null} as="prepared" />
<Ticket.Checkout repository={saved.manifest.assignment.repository} as="afterEvaluation" />
<If condition={afterEvaluation.head !== saved.checkpoint.revision || !afterEvaluation.clean}><Fail message="Source changed while the selected target configuration was evaluated. No reservation was made, no source slot was spent and no role was dispatched; reconcile the source before another admission." /></If>
<Let as="successor" value={prepared.successor} />
<Ticket.Capacity name="successor" as="fits" />
<If condition={!fits}><Fail message="The amended successor exceeds continuation capacity. No reservation was made, no source slot was spent and no role was dispatched." /></If>
```bash exec as="reserved"
mkdir -- {quotedReservation}
```
<If condition={reserved.exitCode !== 0}><Return value={{...held,hold:"The amendment reservation could not be made at " + reservation + ". Preserve it for operator reconciliation; no successor was published."}} /><Else>
<Let as="request" value={prepared.request} />
<Ticket.SaveMetadata name="request" repository={saved.manifest.assignment.repository} path={reservation + "/request.json"} as="requestReceipt" />
<If condition={JSON.stringify(requestReceipt) !== JSON.stringify(prepared.requestDescriptor)}><Fail message={"The saved amendment request differs from its prepared bytes; preserve " + reservation + " for operator reconciliation."} /></If>
<Ticket.Publish record={successor} previous={props.record} as="published" />
<If condition={published.publication !== "confirmed"}><Return value={{...published,hold:"The amended successor publication did not complete. Preserve " + reservation + " and the original continuation; operator disposition is required."}} /><Else>
<Let as="disposition" value={{schema:"delivery-amendment-disposition.v1",status:"admitted",request:prepared.requestDescriptor,predecessor:props.record.continuation,successor:published.continuation,envelope:published}} />
<Ticket.SaveMetadata name="disposition" repository={saved.manifest.assignment.repository} path={reservation + "/disposition.json"} as="dispositionReceipt" />
<Let as="acknowledgment" value={{schema:"delivery-amendment-acknowledgment.v1",record:dispositionReceipt}} />
<Ticket.SaveMetadata name="acknowledgment" repository={saved.manifest.assignment.repository} path={reservation + "/disposition-acknowledged.json"} as="acknowledgmentReceipt" />
<Return value={published} />
</Else></If>
</Else></If>
</Else></If>
