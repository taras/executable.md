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
<Let as="fixture" value={input.fixture} />
<Fixture.Completed fixture={fixture} work="amend-journey" as="completed" />
<Let as="delivery" value={completed.delivery} />
<Let as="original" value={completed.revision} />
<Ticket.Load record={completed.envelope} as="terminal" />
<Dir path={fixture.repository}>
```bash exec as="branchRead"
git symbolic-ref --short HEAD
```
</Dir>
<Let as="remote" value={{revision:original,branch:branchRead.stdout.trim(),base:"main",draft:false,state:"open",merged:false,mergeRevision:null,stable:true,ciGreen:true,ci:{status:"completed",conclusion:"success"},main:{revision:original,run:{status:"completed",conclusion:"success"}},mainRepair:false}} />
<Dir path={fixture.root}><File path="remote.json"><Json value={remote} /></File></Dir>
<Dir path={fixture.root}><Delivery.Status delivery={delivery} number={7} as="atOriginal" /></Dir>
<AssertEquals actual={atOriginal.status} expected="review_pending" />
<Delivery.Review delivery={delivery} revision={original} as="originalReview" />
<Dir path={fixture.root}><Delivery.Status delivery={delivery} number={7} as="originalReady" /></Dir>
<AssertEquals actual={originalReady.status} expected="ready_for_merge" />
<Fixture.Inventory directory={fixture.directory} exclude={["/delivery/called.json"]} as="before" />

Ordinary continuation of the terminal record stays read-only.

<Let as="quote" value={"'\"'\"'"} />
<Let as="entryTail" value={["--include",input.root + "/examples/adversarial-implementation/tests/components","--include",input.root + "/examples/adversarial-implementation/components","--raw"]} />
<Ticket.Continue record={completed.envelope} as="unchanged" />
<AssertEquals actual={unchanged} expected={completed.envelope} />
<Let as="terminalContinue" value={[input.root + "/examples/adversarial-implementation/continue.md","--props-record",completed.record,"--props-steps","1",...entryTail].map(value => "'" + value.replaceAll("'",quote) + "'").join(" ")} />
```bash exec as="terminalEntry"
{input.runner} {terminalContinue}
```
<If condition={terminalEntry.exitCode !== 0}><Fail message={terminalEntry.stderr + terminalEntry.stdout} /></If>
<Parse schema={{type:"object"}} as="terminalReturn">{terminalEntry.stdout}</Parse>
<AssertEquals actual={terminalReturn} expected={completed.envelope} />
<Ticket.Load record={terminalReturn} as="terminalAgain" />
<AssertEquals actual={terminalAgain.calls} expected={terminal.calls} />

An admission that appears while status reads the remote is never ignored, and
an incomplete reservation holds instead of falling back to the original readiness.

<Let as="reservation" value={delivery.directory + "/amendment"} />
<Dir path={fixture.root}><File path="remote.json"><Json value={{...remote,appear:reservation}} /></File></Dir>
<Dir path={fixture.root}><Delivery.Status delivery={delivery} number={7} as="midRead" /></Dir>
<AssertEquals actual={midRead.status} expected="source_changed" />
<Dir path={fixture.root}><File path="remote.json"><Json value={remote} /></File></Dir>
<Dir path={fixture.root}><Delivery.Status delivery={delivery} number={7} as="incomplete" /></Dir>
<AssertEquals actual={incomplete.status} expected="amendment_hold" />
<Fixture.Grant completed={completed} name="journey" as="grant" />
<Ticket.Amend record={completed.envelope} grant={grant.path} as="heldAdmission" />
<AssertEquals actual={[heldAdmission.status,heldAdmission.publication,heldAdmission.continuation]} expected={["hold","held",completed.envelope.continuation]} />
<Let as="quotedReservation" value={"'" + reservation.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="released"
rmdir -- {quotedReservation}
```
<If condition={released.exitCode !== 0}><Fail message={released.stderr} /></If>

The real entry admits once and dispatches nothing.

<Let as="amendArguments" value={[input.root + "/examples/adversarial-implementation/amend-delivery.md","--props-record",completed.record,"--props-grant",grant.path,...entryTail].map(value => "'" + value.replaceAll("'",quote) + "'").join(" ")} />
```bash exec as="amendEntry"
{input.runner} {amendArguments}
```
<If condition={amendEntry.exitCode !== 0}><Fail message={amendEntry.stderr + amendEntry.stdout} /></If>
<Parse schema={{type:"object"}} as="admitted">{amendEntry.stdout}</Parse>
<AssertEquals actual={[admitted.status,admitted.publication,admitted.revision,admitted.nextAction]} expected={["running","confirmed",original,{entry:"continue.md",gate:"implementation",action:"continue_feedback"}]} />
<Ticket.Load record={admitted} as="successor" />
<AssertEquals actual={successor.checkpoint.round} expected={terminal.checkpoint.round + 1} />
<AssertEquals actual={successor.manifest} expected={terminal.manifest} />
<AssertEquals actual={successor.calls} expected={terminal.calls} />
<AssertEquals actual={successor.deliveredInputs} expected={terminal.deliveredInputs} />
<AssertEquals actual={successor.checkpoint.reviews} expected={{}} />
<Let as="nextSlot" value={"'" + (fixture.directory + "/attempts/" + String(terminal.calls.length).padStart(4,"0")).replaceAll("'",quote) + "'"} />
```bash exec as="dispatched"
test -e {nextSlot}
```
<AssertEquals actual={dispatched.exitCode === 0} expected={false} />
<Dir path={fixture.root}><File path="admitted.json"><Json value={admitted} /></File></Dir>
<Ticket.Amend record={completed.envelope} grant={grant.path} as="again" />
<AssertEquals actual={again} expected={admitted} />
<Fixture.Grant completed={completed} name="alternate" as="alternateGrant" />
<Ticket.Amend record={completed.envelope} grant={alternateGrant.path} as="alternateName" />
<AssertEquals actual={alternateName} expected={admitted} />
<Ticket.Publish record={{...terminal,documents:{...terminal.documents,"/alternate-terminal":{...Object.values(terminal.documents)[0],path:"/alternate-terminal"}}}} as="alternateTerminal" />
<AssertEquals actual={alternateTerminal.continuation === completed.envelope.continuation} expected={false} />
<Ticket.Amend record={alternateTerminal} grant={grant.path} as="alternateEnvelope" />
<AssertEquals actual={alternateEnvelope} expected={admitted} />
<Dir path={fixture.root}><Delivery.Status delivery={delivery} number={7} as="admittedStatus" /></Dir>
<AssertEquals actual={admittedStatus.status} expected="feedback_pending" />

Normal continuation prompts the original Implementor for the import.

<Let as="firstContinue" value={[input.root + "/examples/adversarial-implementation/continue.md","--props-record",fixture.root + "/admitted.json","--props-steps","1",...entryTail].map(value => "'" + value.replaceAll("'",quote) + "'").join(" ")} />
```bash exec as="importEntry"
{input.runner} {firstContinue}
```
<If condition={importEntry.exitCode !== 0}><Fail message={importEntry.stderr + importEntry.stdout} /></If>
<Parse schema={{type:"object"}} as="importedReturn">{importEntry.stdout}</Parse>
<Ticket.Load record={importedReturn} as="imported" />
<Let as="importCall" value={imported.calls[terminal.calls.length]} />
<AssertEquals actual={[importCall.role,importCall.session,importCall.provider,importCall.initialize,importCall.status]} expected={["implementor","original-implementor","claude",false,"accepted"]} />
<AssertEquals actual={imported.calls.slice(0,terminal.calls.length)} expected={terminal.calls} />
<Let as="amended" value={imported.checkpoint.revision} />
<Dir path={fixture.repository}>
```bash exec as="lineage"
set -e
git rev-list --parents -n 1 {amended}
git diff --name-only {original} {amended}
```
</Dir>
<AssertEquals actual={lineage.stdout.trim().split("\n")} expected={[amended + " " + original,"test-weights.json"]} />
<Ticket.Read path={fixture.repository + "/test-weights.json"} as="importedWeights" />
<AssertEquals actual={importedWeights} expected={grant.weights} />
<Dir path={fixture.root}><File path="remote.json"><Json value={{...remote,revision:amended,main:{revision:amended,run:remote.main.run}}} /></File></Dir>
<Dir path={fixture.root}><Delivery.Status delivery={delivery} number={7} as="oldPassAtAmended" /></Dir>
<AssertEquals actual={oldPassAtAmended.status} expected="feedback_pending" />
<Dir path={fixture.root}><File path="imported.json"><Json value={importedReturn} /></File></Dir>
<Let as="secondContinue" value={[input.root + "/examples/adversarial-implementation/continue.md","--props-record",fixture.root + "/imported.json","--props-steps","1",...entryTail].map(value => "'" + value.replaceAll("'",quote) + "'").join(" ")} />
```bash exec as="reviewEntry"
{input.runner} {secondContinue}
```
<If condition={reviewEntry.exitCode !== 0}><Fail message={reviewEntry.stderr + reviewEntry.stdout} /></If>
<Parse schema={{type:"object"}} as="finishedReturn">{reviewEntry.stdout}</Parse>
<Ticket.Load record={finishedReturn} as="finished" />
<AssertEquals actual={[finished.checkpoint.status,finished.checkpoint.revision,finished.checkpoint.round,finished.checkpoint.reviews]} expected={["feedback_ready",amended,terminal.checkpoint.round + 1,{planner:amended}]} />
<Let as="reviewCall" value={finished.calls[terminal.calls.length + 1]} />
<AssertEquals actual={[reviewCall.role,reviewCall.session,reviewCall.initialize,finished.calls.length]} expected={["planner","original-planner",false,terminal.calls.length + 2]} />
<AssertEquals actual={[finished.manifest.maxCorrections,finished.manifest.maxApiRepairs,finished.manifest.maxResponseCorrections]} expected={[terminal.manifest.maxCorrections,terminal.manifest.maxApiRepairs,terminal.manifest.maxResponseCorrections]} />
<AssertEquals actual={finishedReturn.nextAction} expected={{entry:"delivery.md",record:delivery.directory + "/requirements.json",action:"review"}} />

Delivery requires the amended head's own feedback, review, CI and main health.

<Dir path={fixture.root}><Delivery.Status delivery={delivery} number={7} as="amendedPending" /></Dir>
<AssertEquals actual={[amendedPending.status,amendedPending.revision,amendedPending.amendment]} expected={["review_pending",amended,{state:"feedback",feedback:reservation + "/feedback.json"}]} />
<Delivery.Review delivery={delivery} revision={amended} as="amendedReview" />
<Dir path={fixture.root}><Delivery.Status delivery={delivery} number={7} as="amendedReady" /></Dir>
<AssertEquals actual={[amendedReady.status,amendedReady.revision]} expected={["ready_for_merge",amended]} />
<Each in={[
 {change:{ci:{status:"in_progress",conclusion:null}},status:"checks_pending"},
 {change:{ci:{status:"completed",conclusion:"failure"}},status:"checks_failed"},
 {change:{main:{revision:amended,run:{status:"in_progress",conclusion:null}}},status:"checks_pending"},
 {change:{stable:false},status:"source_changed"},
 {change:{revision:original},status:"source_changed"}
]} let="change">
<Dir path={fixture.root}><File path="remote.json"><Json value={{...remote,revision:amended,main:{revision:amended,run:remote.main.run},...change.change}} /></File></Dir>
<Dir path={fixture.root}><Delivery.Status delivery={delivery} number={7} as="changed" /></Dir>
<AssertEquals actual={changed.status} expected={change.status} />
</Each>

Every earlier record keeps its bytes; new evidence uses new references.

<Fixture.Inventory directory={fixture.directory} exclude={["/delivery/called.json"]} as="after" />
<Each in={Object.keys(before)} let="path"><AssertEquals actual={[path,after[path]]} expected={[path,before[path]]} /></Each>
<Ticket.Text path={delivery.directory + "/feedback.json"} as="originalFeedback" />
<Parse schema={{type:"object"}} as="originalFeedbackValue">{originalFeedback}</Parse>
<AssertEquals actual={originalFeedbackValue} expected={{status:"feedback_ready",revision:original}} />
<Dir path={fixture.repository}>
<File path="unrelated.txt">An external change after delivery review.</File>
```bash exec as="external"
git add unrelated.txt
git commit -qm 'external change'
```
</Dir>
<If condition={external.exitCode !== 0}><Fail message={external.stderr} /></If>
<Dir path={fixture.root}><Delivery.Status delivery={delivery} number={7} as="externallyAdvanced" /></Dir>
<AssertEquals actual={externallyAdvanced.status} expected="source_changed" />
<Output><Json value={{original,amended,admitted:admitted.continuation,finished:finishedReturn.continuation}} /></Output>
