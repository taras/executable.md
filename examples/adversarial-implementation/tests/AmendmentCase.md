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
<Let as="work" value={{refusals:"amend-refusals",publication:"amend-publication",disposition:"amend-disposition","disposition-unknown":"amend-disposition-unknown","feedback-unknown":"amend-feedback-unknown",sources:"amend-sources","config-settlement":"amend-config","target-excludes":"amend-target-excludes",correction:"amend-correction",exhausted:"amend-correction"}[scenario] ?? scenario} />
<Let as="targetOnly" value={[{path:"packages/a/tests/a.test.ts",reason:"Target-only fixture exclusion.",issue:"https://example.invalid/fixture-target-exclusion"}]} />
<Let as="configurations" value={{"missing-config":null,"malformed-config":"export const exclusions = { deno: [], node: [{ path: 1 }] };","sentinel":"throw new Error(\"SENTINEL target configuration body ran\");\nexport const exclusions = { deno: [], node: [], bun: [] };"}} />
<If condition={Object.hasOwn(configurations,scenario)}>
<Fixture.Completed fixture={fixture} work={"amend-" + scenario} configuration={configurations[scenario]} as="completed" />
<Else>
<Fixture.Completed fixture={fixture} work={work} maxCorrections={scenario === "exhausted" ? 1 : 2} exclusions={scenario === "target-excludes" ? {deno:[],node:targetOnly,bun:targetOnly} : {deno:[],node:[],bun:[]}} as="completed" />
</Else></If>
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
 {name:"prose-authority",expected:"delivery-amendment-authority.v1"},
 {name:"absent-loader",expected:"No ComponentModuleLoader is installed"},
 {name:"padded",record:paddedTerminal,expected:"exceeds continuation capacity"}
]} let="refusal">
<Let as="record" value={refusal.record ?? completed.envelope} />
<Fixture.Grant completed={completed} predecessor={record.continuation} variant={["wrong-predecessor","missing-acquisition","partial","mixed","wrong-commit","digest","omit","path-only","stale-source","secret","prose-authority"].includes(refusal.name) ? refusal.name : "valid"} name={refusal.name} as="grant" />
<Dir path={fixture.repository}>
<If condition={refusal.name === "dirty"}><File path="api.sh">An uncommitted change at A.</File></If>
<If condition={refusal.name === "advanced"}>
```bash exec as="advanced"
git commit -q --allow-empty -m 'external advance'
```
</If>
</Dir>
<Let as="loads" value={fixture.root + "/loads-" + refusal.name + ".json"} />
<Ticket.Capture as="refused"><Fixture.Loader events={loads} reservation={reservation} mode={refusal.name === "absent-loader" ? "absent" : "observe"}><Ticket.Amend record={record} grant={refusal.name === "absent" ? grant.directory + "/absent.json" : grant.path} as="unexpected" /></Fixture.Loader><Json value={unexpected} /></Ticket.Capture>
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
<Let as="quotedLoads" value={"'" + loads.replaceAll("'",quote) + "'"} />
```bash exec as="evaluated"
test -e {quotedLoads}
```
<AssertEquals actual={[refusal.name,evaluated.exitCode === 0]} expected={[refusal.name,["partial","mixed","omit","padded"].includes(refusal.name)]} />
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

<If condition={!["refusals","publication","disposition","disposition-unknown","missing-config","malformed-config","sentinel","target-excludes"].includes(scenario)}>
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

<If condition={scenario === "disposition-unknown"}>
A disposition whose rename committed but reported an unknown outcome confirms
nothing: its complete bytes stay held through repeat, continuation and status.

<Ticket.Capture as="unknown"><Fixture.Override match="/amendment/disposition.json" mode="rename-unknown"><Ticket.Amend record={completed.envelope} grant={grant.path} as="unexpected" /></Fixture.Override><Json value={unexpected} /></Ticket.Capture>
<AssertEquals actual={unknown.status} expected="failed" />
<Ticket.Text path={reservation + "/disposition.json"} as="leftText" />
<Parse schema={{type:"object"}} as="left">{leftText}</Parse>
<AssertEquals actual={[left.status,left.envelope.publication]} expected={["admitted","confirmed"]} />
<Dir path={reservation}><Glob include={["**"]} as="reservationFiles" /></Dir>
<AssertEquals actual={reservationFiles.toSorted()} expected={["disposition.json","request.json"]} />
<Fixture.Inventory directory={fixture.directory} as="beforeRepeat" />
<Ticket.Amend record={completed.envelope} grant={grant.path} as="repeated" />
<AssertEquals actual={[repeated.status,repeated.publication,repeated.continuation]} expected={["hold","held",completed.envelope.continuation]} />
<If condition={!repeated.hold.includes("never acknowledged")}><Fail message={"The repeat held for another reason: " + repeated.hold} /></If>
<Ticket.Capture as="bypass"><Ticket.Continue record={left.envelope} maxSteps={1} as="unexpected" /><Json value={unexpected} /></Ticket.Capture>
<If condition={bypass.status !== "failed" || !bypass.failure.includes("never acknowledged")}><Fail message={"The unacknowledged successor was continued: " + bypass.output + bypass.failure} /></If>
```bash exec as="dispatched"
test -e {nextAttempt}
```
<AssertEquals actual={dispatched.exitCode === 0} expected={false} />
<Dir path={fixture.root}><Delivery.Status delivery={delivery} number={7} as="unknownStatus" /></Dir>
<AssertEquals actual={[unknownStatus.status,unknownStatus.nextAction]} expected={["amendment_hold","reconcile_amendment"]} />
<Fixture.Inventory directory={fixture.directory} as="afterRepeat" />
<AssertEquals actual={afterRepeat} expected={beforeRepeat} />
</If>

<If condition={scenario === "feedback-unknown"}>
Final feedback whose rename committed but reported an unknown outcome is never
selected as delivery feedback.

<Ticket.Capture as="unknown"><Fixture.Override match="/amendment/feedback.json" mode="rename-unknown"><Ticket.Continue record={admitted} maxSteps={2} as="unexpected" /></Fixture.Override><Json value={unexpected} /></Ticket.Capture>
<AssertEquals actual={unknown.status} expected="failed" />
<Ticket.Text path={reservation + "/feedback.json"} as="leftText" />
<Parse schema={{type:"object"}} as="left">{leftText}</Parse>
<AssertEquals actual={left.status} expected="feedback_ready" />
<Dir path={reservation}><Glob include={["feedback*.json"]} as="feedbackFiles" /></Dir>
<AssertEquals actual={feedbackFiles} expected={["feedback.json"]} />
<Dir path={fixture.root}><File path="remote.json"><Json value={{...remote,revision:left.revision,main:{revision:left.revision,run:remote.main.run}}} /></File></Dir>
<Dir path={fixture.root}><Delivery.Status delivery={delivery} number={7} as="unknownStatus" /></Dir>
<AssertEquals actual={[unknownStatus.status,unknownStatus.nextAction]} expected={["amendment_hold","reconcile_amendment"]} />
<If condition={!unknownStatus.reason.includes("never acknowledged")}><Fail message={"Status held for another reason: " + unknownStatus.reason} /></If>
</If>

<If condition={["missing-config","malformed-config","sentinel"].includes(scenario)}>
Required target inputs refuse with no fallback corpus, and permission and
selected bytes are checked before the selected module body can run.

<Let as="cases" value={scenario === "sentinel" ? [{variant:"wrong-purpose",expected:"incomplete or unsupported"},{variant:"module-mismatch",expected:"differs from its selected bytes"}] : [{variant:"valid",expected:scenario === "missing-config" ? "is missing at the admitted revision" : "must export exclusions"}]} />
<Each in={cases} let="refusal">
<Fixture.Grant completed={completed} variant={refusal.variant} name={scenario + "-" + refusal.variant} as="grant" />
<Let as="loads" value={fixture.root + "/loads-" + refusal.variant + ".json"} />
<Ticket.Capture as="refused"><Fixture.Loader events={loads} reservation={reservation}><Ticket.Amend record={completed.envelope} grant={grant.path} as="unexpected" /></Fixture.Loader><Json value={unexpected} /></Ticket.Capture>
<If condition={refused.status !== "failed" || !refused.failure.includes(refusal.expected) || refused.failure.includes("SENTINEL")}><Fail message={scenario + " " + refusal.variant + " was not refused as expected: " + refused.output + (refused.failure ?? "")} /></If>
```bash exec as="reserved"
test -e {quotedReservation} -o -L {quotedReservation} -o -e {nextAttempt}
```
<AssertEquals actual={reserved.exitCode === 0} expected={false} />
<Let as="quotedLoads" value={"'" + loads.replaceAll("'",quote) + "'"} />
```bash exec as="evaluations"
cat {quotedLoads} 2>/dev/null || printf '[]'
```
<Parse schema={{type:"array"}} as="events">{evaluations.stdout}</Parse>
<AssertEquals actual={events} expected={scenario === "malformed-config" ? [{event:"load",reserved:false},{event:"cleanup",reserved:false}] : []} />
</Each>
</If>

<If condition={scenario === "target-excludes"}>
The target's own exclusions decide applicability: records built from the
workflow's table refuse, and records for the target's corpus admit and settle.

<Fixture.Grant completed={completed} corpus={{deno:["packages/a/tests/a.test.ts","scripts/tests/build-npm.test.ts"],node:["packages/a/tests/a.test.ts"],bun:["packages/a/tests/a.test.ts"]}} name="workflow-derived" as="borrowed" />
<Ticket.Capture as="refused"><Ticket.Amend record={completed.envelope} grant={borrowed.path} as="unexpected" /><Json value={unexpected} /></Ticket.Capture>
<If condition={refused.status !== "failed" || !refused.failure.includes("cannot be assembled")}><Fail message={"Workflow-derived records were not refused: " + refused.output + (refused.failure ?? "")} /></If>
```bash exec as="reserved"
test -e {quotedReservation} -o -L {quotedReservation}
```
<AssertEquals actual={reserved.exitCode === 0} expected={false} />
<Fixture.Grant completed={completed} corpus={{deno:["packages/a/tests/a.test.ts","scripts/tests/build-npm.test.ts"],node:["scripts/tests/build-npm.test.ts"],bun:["scripts/tests/build-npm.test.ts"]}} name="target" as="targetGrant" />
<Fixture.Loader events={fixture.root + "/loads-target.json"} reservation={reservation}><Ticket.Amend record={completed.envelope} grant={targetGrant.path} as="admitted" /></Fixture.Loader>
<AssertEquals actual={[admitted.status,admitted.publication]} expected={["running","confirmed"]} />
<Ticket.Text path={fixture.root + "/loads-target.json"} as="loadText" />
<Parse schema={{type:"array"}} as="events">{loadText}</Parse>
<AssertEquals actual={events} expected={[{event:"load",reserved:false},{event:"cleanup",reserved:false}]} />
<Ticket.Load record={admitted} as="successor" />
<AssertEquals actual={successor.checkpoint.amendment.targetCorpus.applicable} expected={{deno:["packages/a/tests/a.test.ts","scripts/tests/build-npm.test.ts"],node:["scripts/tests/build-npm.test.ts"],bun:["scripts/tests/build-npm.test.ts"]}} />
<Ticket.Continue record={admitted} maxSteps={2} as="finishedReturn" />
<Ticket.Load record={finishedReturn} as="finished" />
<AssertEquals actual={finished.checkpoint.status} expected="feedback_ready" />
<Ticket.Text path={reservation + "/feedback.json"} as="finalText" />
<Parse schema={{type:"object"}} as="finalFeedback">{finalText}</Parse>
<AssertEquals actual={finalFeedback.revision} expected={finished.checkpoint.revision} />
</If>

<If condition={scenario === "config-settlement"}>
Settlement rechecks the selected configuration bytes before evaluating again.

<Fixture.Loader events={fixture.root + "/loads-settlement.json"} reservation={reservation}><Fixture.Override match="/scripts/runtime-test-exclusions.ts" mode="read" content="export const exclusions = { deno: [], node: [], bun: [] }; // changed" flag={fixture.root + "/sources-changed.flag"}><Ticket.Continue record={admitted} maxSteps={1} as="settledReturn" /></Fixture.Override></Fixture.Loader>
<Ticket.Load record={settledReturn} as="settled" />
<AssertEquals actual={[settled.checkpoint.status,settled.checkpoint.hold?.kind,settled.calls.at(-1).status]} expected={["hold","verification_failure","rejected"]} />
<If condition={!settled.checkpoint.hold.reason.includes("differs from its selected bytes")}><Fail message={"Settlement held for another reason: " + settled.checkpoint.hold.reason} /></If>
<Ticket.Read path={settled.calls.at(-1).result} as="canonical" />
<Parse schema={{type:"object"}} as="retained">{canonical}</Parse>
<AssertEquals actual={retained.outcome} expected="complete" />
<Let as="settlementTraces" value={[fixture.root + "/loads-settlement.json",reservation + "/feedback.json"].map(path => "'" + path.replaceAll("'",quote) + "'")} />
```bash exec as="secondEvaluation"
test -e {settlementTraces[0]} -o -e {settlementTraces[1]}
```
<AssertEquals actual={secondEvaluation.exitCode === 0} expected={false} />
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
