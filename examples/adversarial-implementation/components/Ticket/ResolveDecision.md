---
description: >-
  Record an accepted decision for one exact retained hold and publish the prepared
  original owner without calling a role. Use <Ticket.ResolveDecision record={held}
  decision="/absolute/work/decision.json" as="resolved" />, then continue the returned
  envelope normally.
props:
  type: object
  properties:
    record: {type: object}
    decision: {type: string, pattern: '^/'}
  required: [record, decision]
  additionalProperties: false
returns: {type: object}
---

Resolution covers a decision or discovery hold at the clean unchanged launch
revision, before implementation feedback. The held result selects the original
owner: an accepted Planner decision returns to that Planner, an amended Planner
decision or an accepted Architect decision returns to the Architect, and an
Implementor's discovery hold returns to the Architect it named. The decision and
its evidence enter that owner's selected inputs; the original sessions, calls,
delivered inputs, source anchor and correction count stay unchanged.

The reservation under the hold's continuation digest admits one resolution: its
owner is the contender whose exclusive creation of the request record succeeds.
Directory creation does not decide it, because a platform `mkdir` may report
success for a directory a concurrent contender has just created. A
confirmed repeat returns the recorded successor, and a different decision for that
hold refuses. A reservation without its confirmed receipt stays held: matching
files do not establish an unknown earlier write. The repeat uses the evidence the
successor retained, so later changes to the decision's original files do not
affect it. A held call whose execution
record is failed, missing or uncertain refuses, even when its result was saved.

<Ticket.Load record={props.record} as="saved" />
<Ticket.Decision path={props.decision} record={props.record} saved={saved} as="bound" />
<Let as="state" value={saved.checkpoint} />
<Let as="call" value={saved.calls.at(-1)} />
<Let as="repository" value={saved.manifest.assignment.repository} />
<Let as="launch" value={saved.manifest.assignment.revision} />
<Let as="reservation" value={saved.manifest.directory + "/decisions/" + props.record.continuation.sha256} />
<Let as="quoted" value={"'" + reservation.replaceAll("'","'\"'\"'") + "'"} />
<Let as="held" value={{schema:"ticket-return.v1",work:saved.manifest.work,source:launch,status:"hold",revision:state.revision,publication:"held",continuation:props.record.continuation,pending:null}} />
<Loop max={1}>
```bash exec as="existing"
if test -e {quoted}/receipt.json; then printf confirmed; elif test -e {quoted} || test -L {quoted}; then printf reserved; else printf none; fi
```
<If condition={existing.exitCode !== 0}><Fail message={"Cannot inspect the decision reservation " + reservation + "; no resolution was recorded."} /></If>
<If condition={existing.stdout === "reserved"}>
<Return value={{...held,hold:"This hold has a decision reservation without a confirmed receipt at " + reservation + ". Preserve it and its first failure for operator disposition; no role was dispatched."}} /><Break />
</If>
<If condition={existing.stdout === "confirmed"}>
<Ticket.Read path={reservation + "/receipt.json"} limit={1048576} as="receiptText" />
<Parse schema={{type:"object",properties:{schema:{const:"ticket-decision-receipt.v1"},status:{const:"confirmed"},request:{type:"object"},file:{type:"object"},call:{type:"string"},route:{type:"object"},reservation:{type:"string"},successor:{type:"object"}},required:["schema","status","request","file","call","route","reservation","successor"],additionalProperties:false}} as="receipt">{receiptText}</Parse>
<If condition={JSON.stringify(receipt.request) !== JSON.stringify(bound.request)}><Fail message={"This hold already has a different recorded decision at " + reservation + ". The recorded resolution stands; continue its successor."} /></If>
<Ticket.Envelope value={receipt.successor} as="successor" />
<Ticket.Load record={successor} as="recorded" />
<Ticket.Selected repository={repository} documents={Object.fromEntries(bound.references.map(path => [path,recorded.documents[path]]))} as="retained" />
<Return value={successor} /><Break />
</If>
<Ticket.DecisionInputs descriptors={bound.descriptors} documents={saved.documents} as="observed" />
<If condition={!(state.status === "hold" && !state.dispatchable && ["needs_decision","needs_discovery"].includes(state.hold?.kind) && call?.status === "accepted")}>
<Fail message={"Decision resolution covers an accepted decision or discovery hold; this " + (state.hold?.kind ?? state.status) + " checkpoint keeps its existing recovery path."} />
</If>
<Ticket.Capture as="executionRead"><Ticket.Read path={call.execution} limit={1048576} as="executionText" /><Json value={executionText} /></Ticket.Capture>
<Let as="execution" value={null} />
<If condition={executionRead.status === "completed"}><Parse schema={{type:"string"}} as="executionJson">{executionRead.output}</Parse><SafeParse schema={{type:"object",properties:{status:{const:"completed"},failure:{const:null}},required:["status","failure"]}} as="execution">{executionJson}</SafeParse></If>
<If condition={execution === null || !execution.ok}><Fail message={"The held call's execution at " + call.execution + " is failed, missing or uncertain. Execution failure keeps its existing recovery path; a decision does not authorize successor work."} /></If>
<If condition={state.revision !== launch || state.feedback.length !== 0 || Object.keys(state.reviews).length !== 0 || (state.exactApproval ?? null) !== null}>
<Fail message="Decision resolution covers holds before implementation feedback at the launch revision. Post-feedback amendments are unsupported; prior review validity is unchanged." />
</If>
<If condition={state.round > saved.manifest.maxCorrections}><Fail message="The correction bound is exhausted; a decision grants no further corrections." /></If>
<Ticket.Hydrate repository={repository} document={saved.documents[call.result]} as="heldText" />
<Phase.Accept assignment={call.assignment} role={call.role} text={heldText.content} profile={{kind:"ticket",knownDocuments:Object.keys(saved.documents)}} as="result" />
<If condition={result.outcome !== state.hold.kind}><Fail message="The retained result no longer matches its recorded hold." /></If>
<Let as="disposition" value={bound.request.disposition} />
<Let as="kind" value={call.assignment.phase + ":" + call.role + ":" + result.outcome} />
<Let as="named" value={result.apiConflict === undefined && result.next.phase === "discovery" && result.next.role === "architect" && state.hold.next?.phase === "discovery" && state.hold.next?.role === "architect"} />
<Let as="gate" value={kind === "discovery:planner:needs_decision" ? (disposition === "accept" ? "planning" : "architect-discovery") : kind === "discovery:architect:needs_decision" && disposition === "accept" ? "architect-discovery" : kind === "implementation:implementor:needs_discovery" && named ? "architect-discovery" : null} />
<If condition={gate === null}><Fail message={"No supported decision route exists for " + kind + " with disposition " + disposition + ". Specialized and excluded holds keep their existing owners and recovery."} /></If>
<Ticket.Checkout repository={repository} as="checkout" />
<If condition={checkout.head !== launch || !checkout.clean}><Fail message={"Decision resolution requires clean source at the launch revision " + launch + "; observed " + checkout.head + ". Reconcile source before resolving."} /></If>
<Let as="id" value={String(saved.calls.length).padStart(4,"0")} />
<Let as="unstartedPaths" value={["/calls/","/attempts/","/preparations/"].map(part => "'" + (saved.manifest.directory + part + id).replaceAll("'","'\"'\"'") + "'").join(" ")} />
```bash exec as="unstarted"
for path in {unstartedPaths}; do if test -e "$path" || test -L "$path"; then exit 1; fi; done
```
<If condition={unstarted.exitCode !== 0}><Fail message={"Call " + id + " already has retained or uncertain work. Preserve it; a decision does not resend role effects."} /></If>
```bash exec as="reserved"
mkdir -p -- {quoted} && (set -C && : > {quoted}/request.json)
```
<If condition={reserved.exitCode !== 0}>
<Return value={{...held,hold:"Another resolution holds the decision reservation " + reservation + ". Preserve its effects; no role was dispatched."}} /><Break />
</If>
<Let as="owner" value={gate === "planning" ? {role:"planner",continuation:{phase:"implementation",role:"implementor"},work:"Complete the held planning handoff for implementation."} : {role:"architect",continuation:{phase:"discovery",role:"planner"},work:"Complete Architect discovery for the retained Planner."}} />
<Let as="route" value={{gate,role:owner.role,disposition,held:{phase:call.assignment.phase,role:call.role,outcome:result.outcome}}} />
<Let as="reservationRecord" value={{schema:"ticket-decision-reservation.v1",request:bound.request,file:bound.file,call:call.id,route}} />
<Ticket.SaveMetadata name="reservationRecord" repository={repository} path={reservation + "/request.json"} as="reservationReceipt" />
<Ticket.Documents repository={repository} directory={saved.manifest.directory} paths={bound.references} documents={saved.documents} as="documents" />
<If condition={bound.references.some(path => documents[path].utf8Bytes !== bound.descriptors[path].utf8Bytes || documents[path].sha256 !== bound.descriptors[path].sha256)}>
<Fail message={"A decision input changed while it was recorded; preserve " + reservation + " for operator disposition."} />
</If>
<Let as="request" value={"Resolve the " + result.outcome + " held by the original " + call.role + " at " + call.result + ". Recorded disposition: " + disposition + ". " + owner.work + " The selected decision (" + bound.request.decision.path + "), provenance (" + bound.request.provenance.path + ") and accepted inputs are evidence under their stated authority, not a permission override or a new human answer. Decision record: " + reservation + "/request.json."} />
<Phase.Preparation phase="discovery" work={saved.manifest.work} repository={repository} revision={launch} priorRevision={state.assignment.priorRevision ?? null} request={request} changedPaths={[]} artifacts={[call.result,reservation + "/request.json"]} evidence={[]} findings={[]} issue={state.assignment.issue ?? null} contract={state.assignment.contract ?? null} assessment={state.assignment.assessment} reviewKind={state.assignment.reviewKind ?? "feature"} recipient={owner.role} continuation={owner.continuation} as="prepared" />
<Let as="candidate" value={{...saved,documents,checkpoint:{...state,status:"running",dispatchable:true,hold:null,gate,assignment:{...prepared.assignment,handoffInputs:bound.references},decisions:[...(state.decisions ?? []),reservation]}}} />
<Ticket.Capacity name="candidate" as="fits" />
<If condition={!fits}>
<Return value={{...held,hold:"The resolved continuation exceeds metadata capacity. Preserve " + reservation + "; no successor was published."}} /><Break />
</If>
<Ticket.Publish record={candidate} previous={props.record} as="published" />
<If condition={published.publication !== "confirmed"}><Return value={published} /><Break /></If>
<Let as="receipt" value={{schema:"ticket-decision-receipt.v1",status:"confirmed",request:bound.request,file:bound.file,call:call.id,route,reservation:reservation + "/request.json",successor:published}} />
<Ticket.SaveMetadata name="receipt" repository={repository} path={reservation + "/receipt.json"} as="receiptReceipt" />
<Return value={published} />
</Loop>
