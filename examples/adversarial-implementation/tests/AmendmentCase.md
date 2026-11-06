---
props:
  type: object
  properties:
    record: {type: string}
  required: [record]
  additionalProperties: false
---
<Ticket.Text path={props.record} as="text" />
<Parse schema={{type:"object"}} as="input">{text}</Parse>
<Let as="scenario" value={input.scenario} />
<Let as="fixture" value={input.fixture} />
<Let as="quote" value={"'\"'\"'"} />
<Let as="work" value={{refusals:"amend-refusals",publication:"amend-publication",disposition:"amend-disposition",sources:"amend-sources",correction:"amend-correction",exhausted:"amend-correction"}[scenario] ?? scenario} />
<Fixture.Completed fixture={fixture} work={work} maxCorrections={scenario === "exhausted" ? 1 : 2} as="completed" />
<Let as="delivery" value={completed.delivery} />
<Let as="original" value={completed.revision} />
<Let as="reservation" value={delivery.directory + "/amendment"} />
<Let as="quotedReservation" value={"'" + reservation.replaceAll("'",quote) + "'"} />
<Ticket.Load record={completed.envelope} as="terminal" />
<Let as="nextAttempt" value={"'" + (fixture.directory + "/attempts/" + String(terminal.calls.length).padStart(4,"0")).replaceAll("'",quote) + "'"} />
<Let as="remote" value={{revision:original,branch:"main",base:"main",draft:false,state:"open",merged:false,mergeRevision:null,stable:true,ciGreen:true,ci:{status:"completed",conclusion:"success"},main:{revision:original,run:{status:"completed",conclusion:"success"}},mainRepair:false}} />
<Dir path={fixture.root}><File path="remote.json"><Json value={remote} /></File></Dir>

<If condition={scenario === "refusals"}>
Refusals happen before any reservation, slot debit or role prompt.

<Ticket.Publish record={{...terminal,checkpoint:{...terminal.checkpoint,round:terminal.manifest.maxCorrections}}} as="exhaustedTerminal" />
<Let as="padding" value={{path:"/overflow-padding",utf8Bytes:0,sha256:"0".repeat(64),snapshot:"/",observation:"supplied"}} />
<Let as="unpadded" value={JSON.stringify({...terminal,documents:{...terminal.documents,"/overflow-padding":padding}}).length} />
<Ticket.Publish record={{...terminal,documents:{...terminal.documents,"/overflow-padding":{...padding,snapshot:"/" + "x".repeat(1048576 - 256 - unpadded)}}}} as="paddedTerminal" />
<AssertEquals actual={paddedTerminal.publication} expected="confirmed" />
<Each in={[
 {name:"absent",expected:"missing"},
 {name:"wrong-predecessor",expected:"another predecessor continuation"},
 {name:"exhausted",record:exhaustedTerminal,expected:"allowance is exhausted"},
 {name:"dirty",expected:"with tracked changes"},
 {name:"advanced",expected:"must be clean at the original feedback revision"},
 {name:"missing-acquisition",expected:"missing"},
 {name:"partial",expected:"node is partial"},
 {name:"mixed",expected:"bun was measured with attempt 2"},
 {name:"wrong-commit",expected:"must be taken at the original feedback revision"},
 {name:"digest",expected:"differs from the acquired test-weights artifact"},
 {name:"omit",expected:"has no measurement for 1 applicable files"},
 {name:"path-only",expected:"utf8Bytes"},
 {name:"stale-source",expected:"selected new workflow sources differ"},
 {name:"secret",expected:"did not clear enabled protection"},
 {name:"padded",record:paddedTerminal,expected:"exceeds continuation capacity"}
]} let="refusal">
<Let as="record" value={refusal.record ?? completed.envelope} />
<Fixture.Grant completed={completed} predecessor={record.continuation} variant={["wrong-predecessor","missing-acquisition","partial","mixed","wrong-commit","digest","omit","path-only","stale-source","secret"].includes(refusal.name) ? refusal.name : "valid"} name={refusal.name} as="grant" />
<Dir path={fixture.repository}>
<If condition={refusal.name === "dirty"}><File path="api.sh">An uncommitted change at A.</File></If>
<If condition={refusal.name === "advanced"}>
```bash exec as="advanced"
git commit -q --allow-empty -m 'external advance'
```
</If>
</Dir>
<Ticket.Capture as="refused"><Ticket.Amend record={record} grant={refusal.name === "absent" ? grant.directory + "/absent.json" : grant.path} as="unexpected" /><Json value={unexpected} /></Ticket.Capture>
<Dir path={fixture.repository}>
```bash exec as="restored"
git reset -q --hard {original}
```
</Dir>
<If condition={refused.status !== "failed" || !refused.failure.includes(refusal.expected)}><Fail message={refusal.name + " was not refused as expected: " + refused.output + (refused.failure ?? "")} /></If>
```bash exec as="reserved"
test -e {quotedReservation} -o -L {quotedReservation} -o -e {nextAttempt}
```
<AssertEquals actual={[refusal.name,reserved.exitCode === 0]} expected={[refusal.name,false]} />
</Each>
<Ticket.Load record={completed.envelope} as="unchanged" />
<AssertEquals actual={unchanged} expected={terminal} />

An existing reservation without a disposition holds without another admission.

```bash exec as="reservedByHand"
mkdir -- {quotedReservation}
```
<Fixture.Grant completed={completed} name="valid" as="valid" />
<Ticket.Amend record={completed.envelope} grant={valid.path} as="held" />
<AssertEquals actual={[held.status,held.publication,held.continuation]} expected={["hold","held",completed.envelope.continuation]} />
<Dir path={reservation}><Glob include={["**"]} as="reservationFiles" /></Dir>
<AssertEquals actual={reservationFiles} expected={[]} />
<Dir path={fixture.root}><Delivery.Status delivery={delivery} number={7} as="incomplete" /></Dir>
<AssertEquals actual={incomplete.status} expected="amendment_hold" />
</If>

<If condition={scenario !== "refusals"}>
<Fixture.Grant completed={completed} name="valid" as="grant" />
</If>

<If condition={scenario === "publication"}>
An unknown successor publication leaves the reservation without a disposition.

<Fixture.Override match="/continuations/" mode="unknown-write"><Ticket.Amend record={completed.envelope} grant={grant.path} as="unknown" /></Fixture.Override>
<AssertEquals actual={[unknown.status,unknown.publication,unknown.continuation,unknown.failure?.data?.target]} expected={["hold","held",completed.envelope.continuation,"commit-unknown"]} />
<Ticket.Amend record={completed.envelope} grant={grant.path} as="repeated" />
<AssertEquals actual={[repeated.status,repeated.publication]} expected={["hold","held"]} />
<Dir path={reservation}><Glob include={["**"]} as="reservationFiles" /></Dir>
<AssertEquals actual={reservationFiles} expected={["request.json"]} />
<Dir path={fixture.root}><Delivery.Status delivery={delivery} number={7} as="unknownStatus" /></Dir>
<AssertEquals actual={unknownStatus.status} expected="amendment_hold" />
<Ticket.Continue record={completed.envelope} as="readOnly" />
<AssertEquals actual={readOnly} expected={completed.envelope} />
</If>

<If condition={scenario === "disposition"}>
A successor published before a denied disposition write cannot be continued.

<Ticket.Capture as="denied"><Fixture.Override match="/amendment/disposition.json" mode="deny-write"><Ticket.Amend record={completed.envelope} grant={grant.path} as="unexpected" /></Fixture.Override></Ticket.Capture>
<AssertEquals actual={denied.status} expected="failed" />
<Dir path={fixture.directory + "/continuations"}><Glob include={["*.json"]} as="continuations" /></Dir>
<Let as="leaked" value={null} />
<Let as="index" value={0} />
<Loop max={continuations.length}>
<Let as="name" value={continuations[index]} />
<Ticket.Read path={fixture.directory + "/continuations/" + name} limit={1048576} as="stateText" />
<Parse schema={{type:"object"}} as="candidate">{stateText}</Parse>
<If condition={candidate.checkpoint.amendment !== undefined}>
<Let as="leakedPath" value={"'" + (fixture.directory + "/continuations/" + name).replaceAll("'",quote) + "'"} />
```bash exec as="size"
wc -c < {leakedPath}
```
<Let as="leaked" value={{schema:"ticket-return.v1",work:completed.envelope.work,source:completed.envelope.source,status:"running",revision:original,publication:"confirmed",continuation:{path:fixture.directory + "/continuations/" + name,utf8Bytes:Number(size.stdout.trim()),sha256:name.slice(0,-5)},pending:null,hold:null}} />
</If>
<Let as="index" value={index + 1} />
</Loop>
<If condition={leaked === null}><Fail message={"The admitted successor was not retained before the denied disposition write: " + denied.failure} /></If>
<Ticket.Capture as="bypass"><Ticket.Continue record={leaked} maxSteps={1} as="unexpected" /><Json value={unexpected} /></Ticket.Capture>
<If condition={bypass.status !== "failed" || !bypass.failure.includes("no confirmed admission disposition")}><Fail message={"The leaked successor was continued: " + bypass.output + bypass.failure} /></If>
```bash exec as="dispatched"
test -e {nextAttempt}
```
<AssertEquals actual={dispatched.exitCode === 0} expected={false} />
<Ticket.Amend record={completed.envelope} grant={grant.path} as="repeated" />
<AssertEquals actual={[repeated.status,repeated.publication]} expected={["hold","held"]} />
</If>

<If condition={scenario !== "refusals" && scenario !== "publication" && scenario !== "disposition"}>
<Ticket.Amend record={completed.envelope} grant={grant.path} as="admitted" />
<AssertEquals actual={[admitted.status,admitted.publication]} expected={["running","confirmed"]} />
<Ticket.Load record={admitted} as="successor" />
</If>

<If condition={["amend-ci","amend-parent","amend-unsigned","amend-bytes"].includes(scenario)}>
Settlement rechecks the actual import before accepting source or feedback.

<Ticket.Continue record={admitted} maxSteps={1} as="settledReturn" />
<Ticket.Load record={settledReturn} as="settled" />
<Let as="call" value={settled.calls.at(-1)} />
<Let as="expected" value={{"amend-ci":"may change only test-weights.json","amend-parent":"single-parent child","amend-unsigned":"signature verification failed","amend-bytes":"differs from the admitted measured artifact"}[scenario]} />
<AssertEquals actual={[settled.checkpoint.status,settled.checkpoint.hold?.kind,call.status,settled.checkpoint.round,settled.checkpoint.revision]} expected={["hold","verification_failure","rejected",successor.checkpoint.round,original]} />
<If condition={!settled.checkpoint.hold.reason.includes(expected)}><Fail message={"Settlement held for another reason: " + settled.checkpoint.hold.reason} /></If>
<Ticket.Read path={call.result} as="canonical" />
<Parse schema={{type:"object"}} as="retained">{canonical}</Parse>
<AssertEquals actual={retained.outcome} expected="complete" />
<Dir path={fixture.root}><Delivery.Status delivery={delivery} number={7} as="heldStatus" /></Dir>
<AssertEquals actual={heldStatus.status} expected="feedback_pending" />
</If>

<If condition={scenario === "sources"}>
Selected workflow sources are rechecked before dispatch and again at settlement.

<Ticket.Capture as="beforeDispatch"><Fixture.Override match="examples/adversarial-implementation/components/Ticket/Amend.md" mode="read"><Ticket.Continue record={admitted} maxSteps={1} as="unexpected" /></Fixture.Override><Json value={unexpected} /></Ticket.Capture>
<If condition={beforeDispatch.status !== "failed" || !beforeDispatch.failure.includes("workflow sources changed")}><Fail message={"Changed sources were dispatched: " + beforeDispatch.output + beforeDispatch.failure} /></If>
```bash exec as="dispatched"
test -e {nextAttempt}
```
<AssertEquals actual={dispatched.exitCode === 0} expected={false} />
<Fixture.Override match="examples/adversarial-implementation/components/Ticket/Amend.md" mode="read" flag={fixture.root + "/sources-changed.flag"}><Ticket.Continue record={admitted} maxSteps={1} as="settledReturn" /></Fixture.Override>
<Ticket.Load record={settledReturn} as="settled" />
<AssertEquals actual={[settled.checkpoint.status,settled.checkpoint.hold?.kind,settled.calls.at(-1).status]} expected={["hold","verification_failure","rejected"]} />
<If condition={!settled.checkpoint.hold.reason.includes("workflow sources changed")}><Fail message={"Settlement held for another reason: " + settled.checkpoint.hold.reason} /></If>
</If>

<If condition={scenario === "correction" || scenario === "exhausted"}>
A genuine review correction uses the next ordinary slot and keeps the weights-only lineage.

<Ticket.Continue record={admitted} maxSteps={4} as="correctedReturn" />
<Ticket.Load record={correctedReturn} as="corrected" />
<Let as="amendedCalls" value={corrected.calls.slice(terminal.calls.length)} />
<Ticket.Read path={amendedCalls[1].result} as="reviewText" />
<Parse schema={{type:"object"}} as="firstReview">{reviewText}</Parse>
<AssertEquals actual={[amendedCalls[1].role,firstReview.outcome]} expected={["planner","changes_required"]} />
<If condition={scenario === "exhausted"}>
<AssertEquals actual={[corrected.checkpoint.status,corrected.checkpoint.hold?.kind,corrected.checkpoint.round,amendedCalls.length]} expected={["hold","correction_bound",2,2]} />
<Else>
<AssertEquals actual={[corrected.checkpoint.status,corrected.checkpoint.round,amendedCalls.map(call => [call.role,call.status])]} expected={["feedback_ready",2,[["implementor","accepted"],["planner","accepted"],["implementor","accepted"],["planner","accepted"]]]} />
<Let as="final" value={corrected.checkpoint.revision} />
<Dir path={fixture.repository}>
```bash exec as="lineage"
set -e
git rev-parse {final}^
git diff --name-only {original} {final}
```
</Dir>
<AssertEquals actual={lineage.stdout.trim().split("\n")} expected={[amendedCalls[1].assignment.revision,"test-weights.json"]} />
<Ticket.Text path={reservation + "/feedback.json"} as="finalText" />
<Parse schema={{type:"object"}} as="finalFeedback">{finalText}</Parse>
<AssertEquals actual={finalFeedback.revision} expected={final} />
</Else></If>
</If>
<Output><Json value={{scenario,original}} /></Output>
