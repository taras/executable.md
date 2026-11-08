---
props: {type: object, properties: {scenario: {type: string}, fixture: {type: object}, runner: {type: string}, root: {type: string}}, required: [scenario, fixture, runner, root], additionalProperties: false}
---
<Let as="scenario" value={props.scenario} />
<Let as="fixture" value={props.fixture} />
<Fixture.CaptureCase scenario={scenario} fixture={fixture}>
```bash exec as="identity"
git rev-parse HEAD
git symbolic-ref --short HEAD
```
<Let as="revision" value={identity.stdout.trim().split("\n")[0]} />
<Let as="branch" value={identity.stdout.trim().split("\n")[1]} />
<Let as="fable" value={{provider:"claude",model:"fable",effort:null,session:"independent"}} />
<Let as="astra" value={{provider:"codex",model:"gpt-6-astra",effort:null,session:"independent-astra"}} />
<Let as="reviewer" value={scenario === "astra-final" ? {...astra,session:"independent"} : fable} />
<Let as="policy" value={{repository:"taras/executable.md",reviewer,acceptance:[{id:"behavior",source:"accepted.md",requirement:"Keep the accepted behavior."},{id:"evidence",source:"accepted.md",requirement:"Show the focused regression."}]}} />
<Delivery.Prepare task={{work:scenario === "astra-final" ? "turn-failed" : scenario.startsWith("exhausted") || scenario === "interrupted" ? "exhausted" : scenario,repository:fixture.repository,directory:fixture.directory,inputs:["accepted.md"],sessions:{planner:"planner",implementor:"implementor",architect:"architect"},delivery:policy}} inputs={[{path:"accepted.md",content:"The accepted original behavior and its focused regression."}]} as="delivery" />
<Dir path={delivery.directory}><File path="requirements.json"><Json value={delivery} /></File><File path="feedback.json"><Json value={{status:"feedback_ready",revision}} /></File></Dir>
<Ticket.Text path={delivery.directory + "/requirements.json"} as="requirementsBefore" />
<File path="remote.json"><Json value={{revision,branch,base:"main",draft:false,state:"open",merged:false,mergeRevision:null,stable:true,ciGreen:true,ci:{status:"completed",conclusion:"success"},main:{revision,run:{status:"completed",conclusion:"success"}},mainRepair:false}} /></File>
<Let as="attempt" value={delivery.directory + "/review-" + revision} />
<Let as="record" value={fixture.root + "/elicitations.json"} />
<Let as="quote" value={"'\"'\"'"} />
<Let as="entry" value={[props.root + "/examples/adversarial-implementation/delivery.md","--props-record",delivery.directory + "/requirements.json","--props-number","7","--include",props.root + "/examples/adversarial-implementation/tests/components","--include",props.root + "/examples/adversarial-implementation/components","--raw"].map(value => "'" + value.replaceAll("'",quote) + "'").join(" ")} />
<Let as="expected" value={{
 "fable-pass":{review:"completed",status:"ready_for_merge",calls:1,elicits:0,effective:"primary"},
 unavailable:{review:"completed",status:"ready_for_merge",calls:2,elicits:0,effective:"replacement",prompted:[false,true]},
 configuration:{review:"completed",status:"ready_for_merge",calls:2,elicits:0,effective:"replacement",prompted:[false,true]},
 "turn-failed":{review:"completed",status:"ready_for_merge",calls:2,elicits:0,effective:"replacement",prompted:[true,true]},
 exhausted:{review:"completed",status:"review_held",next:"report_review_hold",calls:2,elicits:1,hold:"exhausted"},
 "exhausted-reconcile":{review:"completed",status:"review_held",next:"report_review_hold",calls:2,elicits:1,hold:"exhausted"},
 "exhausted-failure":{review:"failed",status:"review_held",next:"resolve_review_hold",calls:2,elicits:1,hold:"exhausted"},
 interrupted:{review:null,status:"review_held",next:"resolve_review_hold",calls:2,elicits:1,hold:"exhausted"},
 partial:{review:"completed",status:"review_held",next:"report_review_hold",calls:1,elicits:1,hold:"uncertain"},
 "unjoined-primary":{review:"completed",status:"review_held",next:"report_review_hold",calls:1,elicits:1,hold:"uncertain"},
 outside:{review:"completed",status:"review_held",next:"report_review_hold",calls:1,elicits:1,hold:"uncertain"},
 "astra-final":{review:"completed",status:"review_held",next:"report_review_hold",calls:1,elicits:1,hold:"exhausted"},
 repair:{review:"completed",status:"repair_required",calls:1,elicits:0},
 blocked:{review:"completed",status:"blocked",calls:1,elicits:0},
 malformed:{review:"failed",status:"reconciliation_required",calls:1,elicits:0},
 reserved:{review:"failed",status:"reconciliation_required",calls:0,elicits:0}
}[scenario]} />
<If condition={expected === undefined}><Fail message={"Unknown fallback scenario " + scenario} /></If>
<Delivery.Status delivery={delivery} number={7} as="before" />
<Fixture.TraceAssertion line={44} element="AssertEquals"><AssertEquals actual={[before.status,before.nextAction]} expected={["review_pending","review"]} /></Fixture.TraceAssertion>

<If condition={scenario === "reserved"}>
<Delivery.Selection delivery={delivery} revision={revision} as="selection" />
<Dir path={attempt}><File path="selection.json"><Json value={selection} /></File><File path="assignment.json"><Json value={{work:delivery.work,revision,reviewer:fable,acceptance:policy.acceptance,responseSchema:selection.responseSchema}} /></File></Dir>
<Dir path={delivery.directory + "/sessions"}><File path="independent.json"><Json value={{schema:"phase-session.v2",agent:"claude",name:"independent",sessionKey:"independent",cwd:fixture.repository,identity:null,attempted:true,started:null}} /></File></Dir>
<Delivery.Status delivery={delivery} number={7} as="reservedStatus" />
<Fixture.TraceAssertion line={51} element="AssertEquals"><AssertEquals actual={[reservedStatus.status,reservedStatus.reviewAttempts.attempts[0].state]} expected={["reconciliation_required","reserved"]} /></Fixture.TraceAssertion>
```bash exec as="reservedEntry"
{props.runner} {entry} --props-action review
```
<Fixture.TraceAssertion line={55} element="AssertEquals"><AssertEquals actual={reservedEntry.exitCode === 0} expected={false} /></Fixture.TraceAssertion>
<Fixture.TraceAssertion line={56} element="AssertStringIncludes"><AssertStringIncludes actual={reservedEntry.stderr} expected="do not start another review" /></Fixture.TraceAssertion>
</If>
<Let as="execution" value={null} />
<If condition={scenario === "interrupted"}>
<File path="interrupt-input.json"><Json value={{phase:"interrupt-child",fixture,revision}} /></File>
<Let as="childArguments" value={[props.root + "/examples/adversarial-implementation/tests/FallbackCase.md","--props-record",fixture.repository + "/interrupt-input.json","--include",props.root + "/examples/adversarial-implementation/tests/components","--include",props.root + "/examples/adversarial-implementation/components","--raw"].map(value => "'" + value.replaceAll("'",quote) + "'").join(" ")} />
<Let as="quotedRecord" value={"'" + record.replaceAll("'",quote) + "'"} />
```bash exec as="interrupted"
{props.runner} {childArguments} > interrupt.out 2> interrupt.err &
child=$!
for attempt in $(seq 1 900); do
  if test -e {quotedRecord}; then break; fi
  sleep 0.1
done
test -e {quotedRecord}
reached=$?
kill -TERM "$child"
wait "$child"
printf '%s' "$reached"
```
<Fixture.TraceAssertion line={76} element="AssertEquals"><AssertEquals actual={interrupted.stdout} expected="0" /></Fixture.TraceAssertion>
<Else>
<If condition={scenario !== "reserved"}>
<Ticket.Capture as="execution"><Fixture.Elicitation record={record} hold={attempt + "/hold.json"} mode={scenario === "exhausted-failure" ? "fail" : "answer"} answer={{disposition:scenario === "exhausted-reconcile" ? "reconcile" : "hold"}}><Delivery.Review delivery={delivery} revision={revision} as="receipt" /><Json value={receipt} /></Fixture.Elicitation></Ticket.Capture>
</If>
<If condition={scenario === "reserved"}>
<Ticket.Capture as="execution"><Delivery.Review delivery={delivery} revision={revision} as="receipt" /><Json value={receipt} /></Ticket.Capture>
</If>
<If condition={execution.status !== expected.review}><Fail message={scenario + ": review " + execution.status + " " + execution.failure + execution.output} /></If>
</Else>
</If>
<Delivery.Status delivery={delivery} number={7} as="after" />
<If condition={after.status !== expected.status}><Fail message={scenario + ": status " + after.status + " " + JSON.stringify(after.reviewAttempts)} /></If>
<If condition={expected.next !== undefined}><Fixture.TraceAssertion line={89} element="AssertEquals"><AssertEquals actual={after.nextAction} expected={expected.next} /></Fixture.TraceAssertion></If>
<Fixture.Observed delivery={delivery.directory} root={fixture.root} as="observed" />
<Fixture.TraceAssertion line={91} element="AssertEquals"><AssertEquals actual={observed.calls.length} expected={expected.calls} /></Fixture.TraceAssertion>
<Fixture.TraceAssertion line={92} element="AssertEquals"><AssertEquals actual={observed.elicitations.length} expected={expected.elicits} /></Fixture.TraceAssertion>
<Fixture.TraceAssertion line={93} element="AssertEquals"><AssertEquals actual={observed.calls.map(call => call.revision)} expected={observed.calls.map(() => revision)} /></Fixture.TraceAssertion>
<Fixture.TraceAssertion line={94} element="AssertEquals"><AssertEquals actual={observed.calls.map(call => call.reviewer)} expected={[reviewer,astra].slice(0,expected.calls)} /></Fixture.TraceAssertion>
<Fixture.TraceAssertion line={95} element="AssertEquals"><AssertEquals actual={observed.calls.map(call => call.position)} expected={[0,1].slice(0,expected.calls)} /></Fixture.TraceAssertion>
<If condition={expected.prompted !== undefined}><Fixture.TraceAssertion line={96} element="AssertEquals"><AssertEquals actual={observed.calls.map(call => call.prompted)} expected={expected.prompted} /></Fixture.TraceAssertion></If>
<Ticket.Text path={delivery.directory + "/requirements.json"} as="requirementsAfter" />
<Fixture.TraceAssertion line={98} element="AssertEquals"><AssertEquals actual={requirementsAfter} expected={requirementsBefore} /></Fixture.TraceAssertion>
<Ticket.Checkout repository={fixture.repository} as="source" />
<Fixture.TraceAssertion line={100} element="AssertEquals"><AssertEquals actual={[source.head,source.clean]} expected={[revision,true]} /></Fixture.TraceAssertion>

<If condition={expected.calls !== 0}>
<Ticket.Text path={attempt + "/selection.json"} as="selectionText" />
<Parse schema={{type:"object"}} as="retainedSelection">{selectionText}</Parse>
<Fixture.TraceAssertion line={105} element="AssertEquals"><AssertEquals actual={[retainedSelection.revision,retainedSelection.policy,retainedSelection.inputs,retainedSelection.chain]} expected={[revision,policy,delivery.inputs,scenario === "astra-final" ? "astra-final" : "fable-astra"]} /></Fixture.TraceAssertion>
<Ticket.Text path={attempt + "/assignment.json"} as="primaryText" />
<Parse schema={{type:"object"}} as="primaryAssignment">{primaryText}</Parse>
<Fixture.TraceAssertion line={108} element="AssertEquals"><AssertEquals actual={primaryAssignment} expected={{work:delivery.work,revision,reviewer,acceptance:policy.acceptance,responseSchema:retainedSelection.responseSchema}} /></Fixture.TraceAssertion>
<If condition={expected.calls === 2}>
<Ticket.Text path={attempt + "/replacement/assignment.json"} as="replacementText" />
<Parse schema={{type:"object"}} as="replacementAssignment">{replacementText}</Parse>
<Fixture.TraceAssertion line={112} element="AssertEquals"><AssertEquals actual={replacementAssignment} expected={{...primaryAssignment,reviewer:astra}} /></Fixture.TraceAssertion>
<Ticket.Text path={attempt + "/replacement/transition.json"} as="transitionText" />
<Parse schema={{type:"object"}} as="transition">{transitionText}</Parse>
<Fixture.TraceAssertion line={115} element="AssertEquals"><AssertEquals actual={[transition.from,transition.to,transition.reason]} expected={[fable,astra,after.reviewAttempts.attempts[0].reason]} /></Fixture.TraceAssertion>
<Fixture.TraceAssertion line={116} element="AssertEquals"><AssertEquals actual={after.reviewAttempts.attempts.map(item => item.state)} expected={expected.effective === "replacement" ? ["eligible","review"] : ["eligible","eligible"]} /></Fixture.TraceAssertion>
</If>
</If>

<If condition={expected.effective !== undefined}>
<Fixture.TraceAssertion line={121} element="AssertEquals"><AssertEquals actual={after.review.attempt} expected={expected.effective === "primary" ? attempt : attempt + "/replacement"} /></Fixture.TraceAssertion>
<Ticket.Text path={after.review.attempt + "/receipt.json"} as="receiptText" />
<Parse schema={{type:"object"}} as="receipt">{receiptText}</Parse>
<Fixture.TraceAssertion line={124} element="AssertEquals"><AssertEquals actual={[receipt.reviewer,receipt.revision,receipt.acceptance,receipt.result.verdict]} expected={[expected.effective === "primary" ? fable : astra,revision,policy.acceptance,"pass"]} /></Fixture.TraceAssertion>
<Fixture.Inventory directory={attempt} as="joined" />
<Delivery.Closeout delivery={delivery} number={7} as="closeout" />
<Fixture.TraceAssertion line={127} element="AssertEquals"><AssertEquals actual={closeout.status} expected="ready_for_merge" /></Fixture.TraceAssertion>
<Ticket.Text path={delivery.directory + "/closeout.md"} as="report" />
<Fixture.TraceAssertion line={129} element="AssertStringIncludes"><AssertStringIncludes actual={report} expected={"Primary reviewer: claude, requested model fable, configured model " + (["unavailable","configuration"].includes(scenario) ? "not configured" : "fable") + ", effort provider default, conversation independent. " + (expected.effective === "primary" ? "review" : "eligible")} /></Fixture.TraceAssertion>
<If condition={expected.effective === "replacement"}>
<Fixture.TraceAssertion line={131} element="AssertStringIncludes"><AssertStringIncludes actual={report} expected="Replacement reviewer: codex, requested model gpt-6-astra, configured model gpt-6-astra, effort provider default, conversation independent-astra. review" /></Fixture.TraceAssertion>
<Fixture.TraceAssertion line={132} element="AssertStringIncludes"><AssertStringIncludes actual={report} expected={attempt + "/execution.json"} /></Fixture.TraceAssertion>
</If>
<Fixture.Inventory directory={attempt} as="reported" />
<Fixture.TraceAssertion line={135} element="AssertEquals"><AssertEquals actual={reported} expected={joined} /></Fixture.TraceAssertion>
</If>

<If condition={expected.hold !== undefined}>
<Ticket.Text path={attempt + "/hold.json"} as="holdText" />
<Parse schema={{type:"object"}} as="hold">{holdText}</Parse>
<Fixture.TraceAssertion line={141} element="AssertEquals"><AssertEquals actual={[hold.revision,hold.chain,hold.attempts.length]} expected={[revision,scenario === "astra-final" ? "astra-final" : "fable-astra",expected.calls]} /></Fixture.TraceAssertion>
<Fixture.TraceAssertion line={142} element="AssertStringIncludes"><AssertStringIncludes actual={hold.summary} expected={expected.hold === "exhausted" ? "Every eligible independent reviewer failed" : "is uncertain"} /></Fixture.TraceAssertion>
<Let as="question" value={observed.elicitations[0]} />
<Fixture.TraceAssertion line={144} element="AssertEquals"><AssertEquals actual={question.held} expected={true} /></Fixture.TraceAssertion>
<Fixture.TraceAssertion line={145} element="AssertEquals"><AssertEquals actual={question.schema} expected={{type:"object",properties:{disposition:{type:"string",enum:["hold","reconcile"],title:"Delivery decision",description:"hold leaves delivery waiting. reconcile reads and validates the existing attempt evidence once."}},required:["disposition"],additionalProperties:false}} /></Fixture.TraceAssertion>
<Fixture.TraceAssertion line={146} element="AssertStringIncludes"><AssertStringIncludes actual={question.message} expected={revision} /></Fixture.TraceAssertion>
<Each in={hold.attempts} let="held">
<Fixture.TraceAssertion line={148} element="AssertStringIncludes"><AssertStringIncludes actual={question.message} expected={held.reviewer.provider + " " + held.reviewer.model + " in conversation " + held.reviewer.session + ": " + held.state + ". " + held.reason} /></Fixture.TraceAssertion>
</Each>
<Dir path={attempt}><Glob include={["disposition.json","receipt.json","replacement/receipt.json"]} as="answered" /></Dir>
<Fixture.TraceAssertion line={151} element="AssertEquals"><AssertEquals actual={answered} expected={["exhausted-failure","interrupted"].includes(scenario) ? [] : ["disposition.json"]} /></Fixture.TraceAssertion>
<Fixture.Inventory directory={attempt} as="held" />

Status, closeout and explicit reconciliation of a hold read evidence only.

<Let as="probeReview" value={expected.next === "report_review_hold" ? "yes" : "no"} />
```bash exec as="heldEntries"
set +e
{props.runner} {entry} --props-action status > status.out 2> status.err
printf '%s ' "$?"
{props.runner} {entry} --props-action closeout > closeout.out 2> closeout.err
printf '%s ' "$?"
{props.runner} {entry} --props-action reconcile > reconcile.out 2> reconcile.err
printf '%s ' "$?"
if test {probeReview} = yes; then
  {props.runner} {entry} --props-action review > review.out 2> review.err
  printf '%s ' "$?"
  cat review.err
fi
```
<Fixture.TraceAssertion line={171} element="AssertStringIncludes"><AssertStringIncludes actual={heldEntries.stdout} expected={expected.next === "report_review_hold" ? "0 0 1 1 " : "0 0 1 "} /></Fixture.TraceAssertion>
<If condition={expected.next === "report_review_hold"}><Fixture.TraceAssertion line={172} element="AssertStringIncludes"><AssertStringIncludes actual={heldEntries.stdout} expected="The next action is report_review_hold; do not start another review." /></Fixture.TraceAssertion></If>
<Fixture.Observed delivery={delivery.directory} root={fixture.root} as="readOnly" />
<Fixture.TraceAssertion line={174} element="AssertEquals"><AssertEquals actual={[readOnly.calls.length,readOnly.elicitations.length]} expected={[expected.calls,expected.elicits]} /></Fixture.TraceAssertion>
<Fixture.Inventory directory={attempt} as="unchanged" />
<Fixture.TraceAssertion line={176} element="AssertEquals"><AssertEquals actual={unchanged} expected={held} /></Fixture.TraceAssertion>
</If>

<If condition={scenario === "exhausted-reconcile"}>
<Parse schema={{type:"object"}} as="reconciled">{execution.output}</Parse>
<Fixture.TraceAssertion line={181} element="AssertEquals"><AssertEquals actual={[reconciled.status,reconciled.answer,reconciled.receipt]} expected={["held",{disposition:"reconcile"},null]} /></Fixture.TraceAssertion>
<Fixture.TraceAssertion line={182} element="AssertStringIncludes"><AssertStringIncludes actual={reconciled.reconciliation} expected="no joined review reply" /></Fixture.TraceAssertion>
</If>

<If condition={["exhausted","exhausted-failure","interrupted"].includes(scenario)}>
<Ticket.Text path={attempt + "/hold.json"} as="holdBefore" />
<Ticket.Capture as="again"><Fixture.Elicitation record={record} hold={attempt + "/hold.json"} mode="answer" answer={{disposition:"hold"}}><Delivery.Review delivery={delivery} revision={revision} as="againReceipt" /><Json value={againReceipt} /></Fixture.Elicitation></Ticket.Capture>
<Fixture.Observed delivery={delivery.directory} root={fixture.root} as="represented" />
<Fixture.TraceAssertion line={189} element="AssertEquals"><AssertEquals actual={represented.calls.length} expected={2} /></Fixture.TraceAssertion>
<If condition={scenario === "exhausted"}>
<Fixture.TraceAssertion line={191} element="AssertEquals"><AssertEquals actual={again.status} expected="failed" /></Fixture.TraceAssertion>
<Fixture.TraceAssertion line={192} element="AssertStringIncludes"><AssertStringIncludes actual={again.failure} expected="already exists or cannot be reserved" /></Fixture.TraceAssertion>
<Fixture.TraceAssertion line={193} element="AssertEquals"><AssertEquals actual={represented.elicitations.length} expected={1} /></Fixture.TraceAssertion>
<Else>
<If condition={again.status !== "completed"}><Fail message={scenario + ": " + again.failure} /></If>
<Fixture.TraceAssertion line={196} element="AssertEquals"><AssertEquals actual={represented.elicitations.length} expected={2} /></Fixture.TraceAssertion>
<Fixture.TraceAssertion line={197} element="AssertEquals"><AssertEquals actual={represented.elicitations[1].message} expected={represented.elicitations[0].message} /></Fixture.TraceAssertion>
<Ticket.Text path={attempt + "/disposition.json"} as="dispositionText" />
<Parse schema={{type:"object"}} as="disposition">{dispositionText}</Parse>
<Fixture.TraceAssertion line={200} element="AssertEquals"><AssertEquals actual={disposition.answer} expected={{disposition:"hold"}} /></Fixture.TraceAssertion>
<Delivery.Status delivery={delivery} number={7} as="answered" />
<Fixture.TraceAssertion line={202} element="AssertEquals"><AssertEquals actual={[answered.status,answered.nextAction]} expected={["review_held","report_review_hold"]} /></Fixture.TraceAssertion>
</Else>
</If>
<Ticket.Text path={attempt + "/hold.json"} as="holdAfter" />
<Fixture.TraceAssertion line={206} element="AssertEquals"><AssertEquals actual={holdAfter} expected={holdBefore} /></Fixture.TraceAssertion>
</If>

<If condition={scenario === "partial"}>
<Delivery.Schema as="schemas" />
<Let as="stray" value={{revision,verdict:"pass",summary:"A stray review.",acceptance:["behavior","evidence"],findings:[]}} />
<Let as="strayOutcome" value={{schema:"delivery-review-outcome.v1",reviewer:astra,catalog:{state:"selected",choices:["gpt-6-astra"],model:"gpt-6-astra",advertised:["gpt-6-astra"],failure:null},turn:{state:"reply",reply:JSON.stringify(stray)}}} />
<Dir path={attempt + "/replacement"}><File path="assignment.json"><Json value={{work:delivery.work,revision,reviewer:astra,acceptance:policy.acceptance,responseSchema:schemas.review}} /></File><File path="outcome.json"><Json value={strayOutcome} /></File><File path="execution.json"><Json value={{status:"completed",failure:null}} /></File><File path="raw.txt">{JSON.stringify(stray)}</File><File path="receipt.json"><Json value={{work:delivery.work,revision,reviewer:astra,acceptance:policy.acceptance,responseSchema:schemas.review,result:stray,execution:attempt + "/replacement/execution.json"}} /></File></Dir>
<Delivery.Status delivery={delivery} number={7} as="strayStatus" />
<Fixture.TraceAssertion line={215} element="AssertEquals"><AssertEquals actual={[strayStatus.status,strayStatus.review]} expected={["review_held",null]} /></Fixture.TraceAssertion>
<Ticket.Capture as="strayReconcile"><Delivery.Reconcile delivery={delivery} revision={revision} publish={true} as="strayReceipt" /></Ticket.Capture>
<Fixture.TraceAssertion line={217} element="AssertEquals"><AssertEquals actual={strayReconcile.status} expected="failed" /></Fixture.TraceAssertion>
<Fixture.TraceAssertion line={218} element="AssertStringIncludes"><AssertStringIncludes actual={strayReconcile.failure} expected="No selected review attempt can supply a receipt" /></Fixture.TraceAssertion>
</If>

<If condition={scenario === "fable-pass"}>
<Ticket.Text path={attempt + "/selection.json"} as="originalSelection" />
<Parse schema={{type:"object"}} as="selected">{originalSelection}</Parse>
<Dir path={attempt}><File path="selection.json"><Json value={{...selected,inputs:[{path:"accepted.md",content:"A different source."}]}} /></File></Dir>
<Delivery.Status delivery={delivery} number={7} as="mismatched" />
<Fixture.TraceAssertion line={226} element="AssertEquals"><AssertEquals actual={[mismatched.status,mismatched.reviewAttempts.selection]} expected={["reconciliation_required","mismatch"]} /></Fixture.TraceAssertion>
<Dir path={attempt}><File path="selection.json">{originalSelection}</File></Dir>
<Delivery.Status delivery={delivery} number={7} as="restored" />
<Fixture.TraceAssertion line={229} element="AssertEquals"><AssertEquals actual={restored.status} expected="ready_for_merge" /></Fixture.TraceAssertion>
</If>

<If condition={scenario === "turn-failed"}>
Reopen after the replacement joined but before its derived raw reply and receipt were published.

<Dir path={attempt + "/replacement"}><File.Delete path="raw.txt" /><File.Delete path="receipt.json" /></Dir>
<Delivery.Status delivery={delivery} number={7} as="underived" />
<Fixture.TraceAssertion line={237} element="AssertEquals"><AssertEquals actual={[underived.status,underived.nextAction]} expected={["reconciliation_required","reconcile_original_review"]} /></Fixture.TraceAssertion>
```bash exec as="reconcileEntry"
{props.runner} {entry} --props-action reconcile
```
<If condition={reconcileEntry.exitCode !== 0}><Fail message={reconcileEntry.stderr + reconcileEntry.stdout} /></If>
<Parse schema={{type:"object"}} as="reconcileStatus">{reconcileEntry.stdout}</Parse>
<Fixture.TraceAssertion line={243} element="AssertEquals"><AssertEquals actual={reconcileStatus.status} expected="ready_for_merge" /></Fixture.TraceAssertion>
<Fixture.Observed delivery={delivery.directory} root={fixture.root} as="afterReconcile" />
<Fixture.TraceAssertion line={245} element="AssertEquals"><AssertEquals actual={afterReconcile.calls.length} expected={2} /></Fixture.TraceAssertion>

Reopen with a replacement reservation whose outcome never joined.

<Fixture.Inventory directory={attempt} as="beforeCut" />
<Dir path={attempt + "/replacement"}><File.Delete path="execution.json" /><File.Delete path="outcome.json" /><File.Delete path="raw.txt" /><File.Delete path="receipt.json" /></Dir>
<Delivery.Status delivery={delivery} number={7} as="unjoined" />
<Fixture.TraceAssertion line={252} element="AssertEquals"><AssertEquals actual={[unjoined.status,unjoined.reviewAttempts.attempts[1].state]} expected={["reconciliation_required","reserved"]} /></Fixture.TraceAssertion>
<Ticket.Capture as="heldReplacement"><Delivery.Review delivery={delivery} revision={revision} as="unexpected" /></Ticket.Capture>
<Fixture.TraceAssertion line={254} element="AssertEquals"><AssertEquals actual={heldReplacement.status} expected="failed" /></Fixture.TraceAssertion>
```bash exec as="heldEntry"
{props.runner} {entry} --props-action review
```
<Fixture.TraceAssertion line={258} element="AssertStringIncludes"><AssertStringIncludes actual={heldEntry.stderr} expected="do not start another review" /></Fixture.TraceAssertion>
<Fixture.Observed delivery={delivery.directory} root={fixture.root} as="afterHeld" />
<Fixture.TraceAssertion line={260} element="AssertEquals"><AssertEquals actual={afterHeld.calls.length} expected={2} /></Fixture.TraceAssertion>

Reopen after the primary failure was retained but before the replacement was reserved, from two overlapping review actions.

<Let as="quotedReplacement" value={"'" + (attempt + "/replacement").replaceAll("'",quote) + "'"} />
```bash exec as="cut"
rm -r -- {quotedReplacement}
```
<Delivery.Status delivery={delivery} number={7} as="resumable" />
<Fixture.TraceAssertion line={269} element="AssertEquals"><AssertEquals actual={[resumable.status,resumable.nextAction]} expected={["review_pending","review"]} /></Fixture.TraceAssertion>
```bash exec as="overlap"
{props.runner} {entry} --props-action review > first.out 2> first.err &
first=$!
{props.runner} {entry} --props-action review > second.out 2> second.err &
second=$!
wait "$first"
firstExit=$?
wait "$second"
secondExit=$?
printf '%s %s' "$firstExit" "$secondExit"
```
<Fixture.TraceAssertion line={281} element="AssertEquals" overlap={overlap}><AssertEquals actual={overlap.stdout.split(" ").filter(code => code === "0").length} expected={1} /></Fixture.TraceAssertion>
<Fixture.Observed delivery={delivery.directory} root={fixture.root} as="afterOverlap" />
<Fixture.TraceAssertion line={283} element="AssertEquals"><AssertEquals actual={afterOverlap.calls.map(call => call.position)} expected={[0,1,1]} /></Fixture.TraceAssertion>
<Delivery.Status delivery={delivery} number={7} as="resumed" />
<Fixture.TraceAssertion line={285} element="AssertEquals"><AssertEquals actual={resumed.status} expected="ready_for_merge" /></Fixture.TraceAssertion>
<Fixture.Inventory directory={attempt} as="afterCut" />
<Fixture.TraceAssertion line={287} element="AssertEquals"><AssertEquals actual={Object.keys(afterCut).filter(path => !path.includes("/replacement/")).map(path => afterCut[path])} expected={Object.keys(beforeCut).filter(path => !path.includes("/replacement/")).map(path => beforeCut[path])} /></Fixture.TraceAssertion>
</If>

</Fixture.CaptureCase>
