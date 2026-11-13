---
props: {type: object, properties: {scenario: {type: string}, fixture: {type: object}, runner: {type: string}, root: {type: string}}, required: [scenario, fixture, runner, root], additionalProperties: false}
---
<Let as="scenario" value={props.scenario} />
<Let as="fixture" value={props.fixture} />
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
<AssertEquals actual={[before.status,before.nextAction]} expected={["review_pending","review"]} />

<If condition={scenario === "reserved"}>
<Delivery.Selection delivery={delivery} revision={revision} as="selection" />
<Dir path={attempt}><File path="selection.json"><Json value={selection} /></File><File path="assignment.json"><Json value={{work:delivery.work,revision,reviewer:fable,acceptance:policy.acceptance,responseSchema:selection.responseSchema,maxResponseCorrections:0}} /></File></Dir>
<Dir path={delivery.directory + "/sessions"}><File path="independent.json"><Json value={{schema:"phase-session.v2",agent:"claude",name:"independent",sessionKey:"independent",cwd:fixture.repository,identity:null,attempted:true,started:null}} /></File></Dir>
<Delivery.Status delivery={delivery} number={7} as="reservedStatus" />
<AssertEquals actual={[reservedStatus.status,reservedStatus.reviewAttempts.attempts[0].state]} expected={["reconciliation_required","reserved"]} />
```bash exec as="reservedEntry"
{props.runner} {entry} --props-action review
```
<AssertEquals actual={reservedEntry.exitCode === 0} expected={false} />
<AssertStringIncludes actual={reservedEntry.stderr} expected="do not start another review" />
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
<AssertEquals actual={interrupted.stdout} expected="0" />
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
<If condition={expected.next !== undefined}><AssertEquals actual={after.nextAction} expected={expected.next} /></If>
<Fixture.Observed delivery={delivery.directory} root={fixture.root} as="observed" />
<AssertEquals actual={observed.calls.length} expected={expected.calls} />
<AssertEquals actual={observed.elicitations.length} expected={expected.elicits} />
<AssertEquals actual={observed.calls.map(call => call.revision)} expected={observed.calls.map(() => revision)} />
<AssertEquals actual={observed.calls.map(call => call.reviewer)} expected={[reviewer,astra].slice(0,expected.calls)} />
<AssertEquals actual={observed.calls.map(call => call.position)} expected={[0,1].slice(0,expected.calls)} />
<If condition={expected.prompted !== undefined}><AssertEquals actual={observed.calls.map(call => call.prompted)} expected={expected.prompted} /></If>
<Ticket.Text path={delivery.directory + "/requirements.json"} as="requirementsAfter" />
<AssertEquals actual={requirementsAfter} expected={requirementsBefore} />
<Ticket.Checkout repository={fixture.repository} as="source" />
<AssertEquals actual={[source.head,source.clean]} expected={[revision,true]} />

<If condition={expected.calls !== 0}>
<Ticket.Text path={attempt + "/selection.json"} as="selectionText" />
<Parse schema={{type:"object"}} as="retainedSelection">{selectionText}</Parse>
<AssertEquals actual={[retainedSelection.revision,retainedSelection.policy,retainedSelection.inputs,retainedSelection.chain]} expected={[revision,policy,delivery.inputs,scenario === "astra-final" ? "astra-final" : "fable-astra"]} />
<Ticket.Text path={attempt + "/assignment.json"} as="primaryText" />
<Parse schema={{type:"object"}} as="primaryAssignment">{primaryText}</Parse>
<AssertEquals actual={primaryAssignment} expected={{work:delivery.work,revision,reviewer,acceptance:policy.acceptance,responseSchema:retainedSelection.responseSchema,maxResponseCorrections:0}} />
<If condition={expected.calls === 2}>
<Ticket.Text path={attempt + "/replacement/assignment.json"} as="replacementText" />
<Parse schema={{type:"object"}} as="replacementAssignment">{replacementText}</Parse>
<AssertEquals actual={replacementAssignment} expected={{...primaryAssignment,reviewer:astra}} />
<Ticket.Text path={attempt + "/replacement/transition.json"} as="transitionText" />
<Parse schema={{type:"object"}} as="transition">{transitionText}</Parse>
<AssertEquals actual={[transition.from,transition.to,transition.reason]} expected={[fable,astra,after.reviewAttempts.attempts[0].reason]} />
<AssertEquals actual={after.reviewAttempts.attempts.map(item => item.state)} expected={expected.effective === "replacement" ? ["eligible","review"] : ["eligible","eligible"]} />
</If>
</If>

<If condition={expected.effective !== undefined}>
<AssertEquals actual={after.review.attempt} expected={expected.effective === "primary" ? attempt : attempt + "/replacement"} />
<Ticket.Text path={after.review.attempt + "/receipt.json"} as="receiptText" />
<Parse schema={{type:"object"}} as="receipt">{receiptText}</Parse>
<AssertEquals actual={[receipt.reviewer,receipt.revision,receipt.acceptance,receipt.result.verdict]} expected={[expected.effective === "primary" ? fable : astra,revision,policy.acceptance,"pass"]} />
<Fixture.Inventory directory={attempt} as="joined" />
<Delivery.Closeout delivery={delivery} number={7} as="closeout" />
<AssertEquals actual={closeout.status} expected="ready_for_merge" />
<Ticket.Text path={delivery.directory + "/closeout.md"} as="report" />
<AssertStringIncludes actual={report} expected={"Primary reviewer: claude, requested model fable, configured model " + (["unavailable","configuration"].includes(scenario) ? "not configured" : "fable") + ", effort provider default, conversation independent. " + (expected.effective === "primary" ? "review" : "eligible")} />
<If condition={expected.effective === "replacement"}>
<AssertStringIncludes actual={report} expected="Replacement reviewer: codex, requested model gpt-6-astra, configured model gpt-6-astra, effort provider default, conversation independent-astra. review" />
<AssertStringIncludes actual={report} expected={attempt + "/execution.json"} />
</If>
<Fixture.Inventory directory={attempt} as="reported" />
<AssertEquals actual={reported} expected={joined} />
</If>

<If condition={expected.hold !== undefined}>
<Ticket.Text path={attempt + "/hold.json"} as="holdText" />
<Parse schema={{type:"object"}} as="hold">{holdText}</Parse>
<AssertEquals actual={[hold.revision,hold.chain,hold.attempts.length]} expected={[revision,scenario === "astra-final" ? "astra-final" : "fable-astra",expected.calls]} />
<AssertStringIncludes actual={hold.summary} expected={expected.hold === "exhausted" ? "Every eligible independent reviewer failed" : "is uncertain"} />
<Let as="question" value={observed.elicitations[0]} />
<AssertEquals actual={question.held} expected={true} />
<AssertEquals actual={question.schema} expected={{type:"object",properties:{disposition:{type:"string",enum:["hold","reconcile"],title:"Delivery decision",description:"hold leaves delivery waiting. reconcile reads and validates the existing attempt evidence once."}},required:["disposition"],additionalProperties:false}} />
<AssertStringIncludes actual={question.message} expected={revision} />
<Each in={hold.attempts} let="held">
<AssertStringIncludes actual={question.message} expected={held.reviewer.provider + " " + held.reviewer.model + " in conversation " + held.reviewer.session + ": " + held.state + ". " + held.reason} />
</Each>
<Dir path={attempt}><Glob include={["disposition.json","receipt.json","replacement/receipt.json"]} as="answered" /></Dir>
<AssertEquals actual={answered} expected={["exhausted-failure","interrupted"].includes(scenario) ? [] : ["disposition.json"]} />
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
<AssertStringIncludes actual={heldEntries.stdout} expected={expected.next === "report_review_hold" ? "0 0 1 1 " : "0 0 1 "} />
<If condition={expected.next === "report_review_hold"}><AssertStringIncludes actual={heldEntries.stdout} expected="The next action is report_review_hold; do not start another review." /></If>
<Fixture.Observed delivery={delivery.directory} root={fixture.root} as="readOnly" />
<AssertEquals actual={[readOnly.calls.length,readOnly.elicitations.length]} expected={[expected.calls,expected.elicits]} />
<Fixture.Inventory directory={attempt} as="unchanged" />
<AssertEquals actual={unchanged} expected={held} />
</If>

<If condition={scenario === "exhausted-reconcile"}>
<Parse schema={{type:"object"}} as="reconciled">{execution.output}</Parse>
<AssertEquals actual={[reconciled.status,reconciled.answer,reconciled.receipt]} expected={["held",{disposition:"reconcile"},null]} />
<AssertStringIncludes actual={reconciled.reconciliation} expected="no joined review reply" />
</If>

<If condition={["exhausted","exhausted-failure","interrupted"].includes(scenario)}>
<Ticket.Text path={attempt + "/hold.json"} as="holdBefore" />
<Ticket.Capture as="again"><Fixture.Elicitation record={record} hold={attempt + "/hold.json"} mode="answer" answer={{disposition:"hold"}}><Delivery.Review delivery={delivery} revision={revision} as="againReceipt" /><Json value={againReceipt} /></Fixture.Elicitation></Ticket.Capture>
<Fixture.Observed delivery={delivery.directory} root={fixture.root} as="represented" />
<AssertEquals actual={represented.calls.length} expected={2} />
<If condition={scenario === "exhausted"}>
<AssertEquals actual={again.status} expected="failed" />
<AssertStringIncludes actual={again.failure} expected="already exists or cannot be reserved" />
<AssertEquals actual={represented.elicitations.length} expected={1} />
<Else>
<If condition={again.status !== "completed"}><Fail message={scenario + ": " + again.failure} /></If>
<AssertEquals actual={represented.elicitations.length} expected={2} />
<AssertEquals actual={represented.elicitations[1].message} expected={represented.elicitations[0].message} />
<Ticket.Text path={attempt + "/disposition.json"} as="dispositionText" />
<Parse schema={{type:"object"}} as="disposition">{dispositionText}</Parse>
<AssertEquals actual={disposition.answer} expected={{disposition:"hold"}} />
<Delivery.Status delivery={delivery} number={7} as="answered" />
<AssertEquals actual={[answered.status,answered.nextAction]} expected={["review_held","report_review_hold"]} />
</Else>
</If>
<Ticket.Text path={attempt + "/hold.json"} as="holdAfter" />
<AssertEquals actual={holdAfter} expected={holdBefore} />
</If>

<If condition={scenario === "partial"}>
<Delivery.Schema as="schemas" />
<Let as="stray" value={{revision,verdict:"pass",summary:"A stray review.",acceptance:["behavior","evidence"],findings:[]}} />
<Let as="strayOutcome" value={{schema:"delivery-review-outcome.v1",reviewer:astra,catalog:{state:"selected",choices:["gpt-6-astra"],model:"gpt-6-astra",advertised:["gpt-6-astra"],failure:null},turn:{state:"reply",reply:JSON.stringify(stray)}}} />
<Dir path={attempt + "/replacement"}><File path="assignment.json"><Json value={{work:delivery.work,revision,reviewer:astra,acceptance:policy.acceptance,responseSchema:schemas.review,maxResponseCorrections:0}} /></File><File path="outcome.json"><Json value={strayOutcome} /></File><File path="execution.json"><Json value={{status:"completed",failure:null}} /></File><File path="raw.txt">{JSON.stringify(stray)}</File><File path="receipt.json"><Json value={{work:delivery.work,revision,reviewer:astra,acceptance:policy.acceptance,responseSchema:schemas.review,maxResponseCorrections:0,result:stray,execution:attempt + "/replacement/execution.json"}} /></File></Dir>
<Delivery.Status delivery={delivery} number={7} as="strayStatus" />
<AssertEquals actual={[strayStatus.status,strayStatus.review]} expected={["review_held",null]} />
<Ticket.Capture as="strayReconcile"><Delivery.Reconcile delivery={delivery} revision={revision} publish={true} as="strayReceipt" /></Ticket.Capture>
<AssertEquals actual={strayReconcile.status} expected="failed" />
<AssertStringIncludes actual={strayReconcile.failure} expected="No selected review attempt can supply a receipt" />
</If>

<If condition={scenario === "fable-pass"}>
<Ticket.Text path={attempt + "/selection.json"} as="originalSelection" />
<Parse schema={{type:"object"}} as="selected">{originalSelection}</Parse>
<Dir path={attempt}><File path="selection.json"><Json value={{...selected,inputs:[{path:"accepted.md",content:"A different source."}]}} /></File></Dir>
<Delivery.Status delivery={delivery} number={7} as="mismatched" />
<AssertEquals actual={[mismatched.status,mismatched.reviewAttempts.selection]} expected={["reconciliation_required","mismatch"]} />
<Dir path={attempt}><File path="selection.json">{originalSelection}</File></Dir>
<Delivery.Status delivery={delivery} number={7} as="restored" />
<AssertEquals actual={restored.status} expected="ready_for_merge" />
</If>

<If condition={scenario === "turn-failed"}>
Reopen after the replacement joined but before its derived raw reply and receipt were published.

<Dir path={attempt + "/replacement"}><File.Delete path="raw.txt" /><File.Delete path="receipt.json" /></Dir>
<Delivery.Status delivery={delivery} number={7} as="underived" />
<AssertEquals actual={[underived.status,underived.nextAction]} expected={["reconciliation_required","reconcile_original_review"]} />
```bash exec as="reconcileEntry"
{props.runner} {entry} --props-action reconcile
```
<If condition={reconcileEntry.exitCode !== 0}><Fail message={reconcileEntry.stderr + reconcileEntry.stdout} /></If>
<Parse schema={{type:"object"}} as="reconcileStatus">{reconcileEntry.stdout}</Parse>
<AssertEquals actual={reconcileStatus.status} expected="ready_for_merge" />
<Fixture.Observed delivery={delivery.directory} root={fixture.root} as="afterReconcile" />
<AssertEquals actual={afterReconcile.calls.length} expected={2} />

Reopen with a replacement reservation whose outcome never joined.

<Fixture.Inventory directory={attempt} as="beforeCut" />
<Dir path={attempt + "/replacement"}><File.Delete path="execution.json" /><File.Delete path="outcome.json" /><File.Delete path="raw.txt" /><File.Delete path="receipt.json" /></Dir>
<Delivery.Status delivery={delivery} number={7} as="unjoined" />
<AssertEquals actual={[unjoined.status,unjoined.reviewAttempts.attempts[1].state]} expected={["reconciliation_required","reserved"]} />
<Ticket.Capture as="heldReplacement"><Delivery.Review delivery={delivery} revision={revision} as="unexpected" /></Ticket.Capture>
<AssertEquals actual={heldReplacement.status} expected="failed" />
```bash exec as="heldEntry"
{props.runner} {entry} --props-action review
```
<AssertStringIncludes actual={heldEntry.stderr} expected="do not start another review" />
<Fixture.Observed delivery={delivery.directory} root={fixture.root} as="afterHeld" />
<AssertEquals actual={afterHeld.calls.length} expected={2} />

Reopen after the primary failure was retained but before the replacement was reserved, from two overlapping review actions.

<Let as="quotedReplacement" value={"'" + (attempt + "/replacement").replaceAll("'",quote) + "'"} />
```bash exec as="cut"
rm -r -- {quotedReplacement}
```
<Delivery.Status delivery={delivery} number={7} as="resumable" />
<AssertEquals actual={[resumable.status,resumable.nextAction]} expected={["review_pending","review"]} />
```bash exec as="overlap"
{props.runner} {entry} --props-action review --verbose > first.out 2> first.err &
first=$!
{props.runner} {entry} --props-action review --verbose > second.out 2> second.err &
second=$!
wait "$first"
firstExit=$?
wait "$second"
secondExit=$?
zeros=0
if test "$firstExit" = 0; then zeros=$((zeros + 1)); fi
if test "$secondExit" = 0; then zeros=$((zeros + 1)); fi
if test "$zeros" != 1; then
  printf 'overlap-waits first=%s:%s second=%s:%s\n' "$first" "$firstExit" "$second" "$secondExit" >&2
fi
printf '%s %s' "$firstExit" "$secondExit"
```
<Let as="zeroExits" value={overlap.stdout.split(" ").filter(code => code === "0").length} />
<If condition={zeroExits !== 1}>
<Let as="evidenceArguments" value={[overlap.stdout.slice(0,64),overlap.stderr.slice(0,512),delivery.directory + "/called.json",attempt + "/replacement","first.out","first.err","second.out","second.err"].map(value => "'" + value.replaceAll("'",quote) + "'").join(" ")} />
```bash exec as="overlapEvidence"
deno run --quiet --no-config --no-lock --no-code-cache --ext=js --allow-read - {evidenceArguments} <<'COLLECT'
const LIMIT = 16384;
const STATUSES = ["feedback_pending", "source_changed", "reconciliation_required", "review_pending", "repair_required", "blocked", "review_held", "checks_failed", "checks_pending", "delivered", "closed_unmerged", "publication_pending", "ready_for_merge"];
const ACTIONS = ["continue_feedback", "review", "request_approved_repair", "reconcile_original_review", "wait_for_checks", "repair_failed_check", "finish_pr_metadata", "await_authorized_merge", "report_delivery", "report_review_blocker", "resolve_review_hold", "report_review_hold", "reconcile_source"];
const REFUSALS = [["do not start another review", "action-gate-refusal"], ["The review attempt already exists or cannot be reserved", "attempt-reservation-refusal"], ["The replacement review is already reserved", "replacement-reservation-refusal"]];
const [tokens, shell, called, replacement, firstOut, firstErr, secondOut, secondErr] = Deno.args;
async function read(path) {
  let file;
  try {
    file = await Deno.open(path);
  } catch {
    return { state: "unavailable" };
  }
  try {
    const buffer = new Uint8Array(LIMIT + 1);
    let total = 0;
    while (buffer.length > total) {
      const count = await file.read(buffer.subarray(total));
      if (count === null) {
        break;
      }
      total += count;
    }
    if (total > LIMIT) {
      return { state: "oversize" };
    }
    return { state: "read", text: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total)) };
  } catch {
    return { state: "unavailable" };
  } finally {
    file.close();
  }
}
function parsed(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
async function stdoutSummary(path) {
  const channel = await read(path);
  if (channel.state !== "read") {
    return channel.state;
  }
  if (channel.text.trim() === "") {
    return "empty";
  }
  const value = parsed(channel.text);
  return STATUSES.includes(value?.status) && ACTIONS.includes(value?.nextAction) ? "status " + value.status + "/" + value.nextAction : "other-redacted";
}
const CEILING = 1048576;
const LINE = 4096;
const ESCAPE = /\u001b\[[0-9;]*[A-Za-z]/g;
const EVENT = /\[(yield|close)\] /;
const FIXTURE_ROLE = "/tests/components/Delivery/Role.md";
const PRODUCTION_ROLE = "/components/Delivery/Role.md";
function exitToken(rest) {
  const status = /^ → (ok|err)/.exec(rest);
  if (status === null) {
    return "?";
  }
  if (status[1] === "err") {
    return "E";
  }
  const code = /exitCode: (-?[0-9]{1,3})[,} ]/.exec(rest);
  return code === null ? "?" : code[1];
}
function classify(state, text) {
  const at = text.search(EVENT);
  const body = at === -1 ? text : text.slice(0, at);
  if (body.trim() !== "") {
    state.nonEvent += 1;
    for (const [phrase, label] of REFUSALS) {
      if (body.includes(phrase) && !state.refusals.includes(label)) {
        state.refusals.push(label);
      }
    }
  }
  if (at === -1) {
    return;
  }
  const event = text.slice(at);
  state.events += 1;
  if (event.startsWith("[close] ")) {
    const close = /^\[close\] root → ([a-z]{1,16})/.exec(event);
    if (close !== null) {
      state.rootClose = close[1];
    }
    return;
  }
  const arrow = event.indexOf(" → ");
  const name = arrow === -1 ? event.slice(8) : event.slice(8, arrow);
  const rest = arrow === -1 ? "" : event.slice(arrow);
  const ok = rest.startsWith(" → ok");
  const phase = state.mkdirs.length === 0 ? "before" : "after";
  if (name.startsWith("exec:exec:test -e ")) {
    state.probeCount += 1;
    if (state.probes.length < 8) {
      state.probes.push(exitToken(rest));
    }
    if (state.mkdirs.length === 0) {
      state.lastPair = [state.lastPair[1], exitToken(rest)];
      state.pairSeen += 1;
    }
  } else if (name.startsWith("exec:exec:mkdir -- ")) {
    state.mkdirCount += 1;
    if (state.mkdirs.length < 4) {
      state.mkdirs.push(exitToken(rest));
    }
    if (state.mkdirCount === 1) {
      state.firstMkdir = { preview: name.slice(19), pair: state.lastPair.slice(), pairs: state.pairSeen };
    }
  } else if (name === "import_component:Delivery.Dispatch" && ok) {
    state.dispatch[phase] += 1;
  } else if (name === "import_component:Delivery.Role" && ok) {
    const path = /path: '([^']*)'/.exec(rest);
    const kind = path === null ? "other" : path[1].endsWith(FIXTURE_ROLE) ? "fixture" : path[1].endsWith(PRODUCTION_ROLE) ? "production" : "other";
    state.role[kind][phase] += 1;
  } else if (name === "import_component:Fail" && ok) {
    state.fail[phase] += 1;
  }
}
function attribution(state, replacementPath) {
  if (state.firstMkdir === null) {
    return "none";
  }
  const preview = state.firstMkdir.preview;
  const quoted = "'" + replacementPath + "'";
  const consistent = preview.trimEnd().length > 1 && quoted.startsWith(preview.trimEnd());
  if (!consistent) {
    return "ambiguous preview-mismatch";
  }
  if (2 > state.firstMkdir.pairs) {
    return "ambiguous no-preceding-probe-pair";
  }
  const [primary, replaced] = state.firstMkdir.pair;
  if (primary !== "0") {
    return "ambiguous primary-not-occupied";
  }
  if (replaced === "0" || replaced === "?" || replaced === "E") {
    return "ambiguous replacement-probe-" + (replaced === "0" ? "present" : "unread");
  }
  return state.mkdirCount === 1 ? "replacement" : "replacement-first-of-" + Math.min(state.mkdirCount, 99);
}
async function trace(path, replacementPath) {
  const state = { events: 0, nonEvent: 0, clipped: 0, refusals: [], probes: [], probeCount: 0, lastPair: ["-", "-"], pairSeen: 0, mkdirs: [], mkdirCount: 0, firstMkdir: null, dispatch: { before: 0, after: 0 }, role: { fixture: { before: 0, after: 0 }, production: { before: 0, after: 0 }, other: { before: 0, after: 0 } }, fail: { before: 0, after: 0 }, rootClose: null };
  let file;
  try {
    file = await Deno.open(path);
  } catch {
    return "unavailable";
  }
  let bytes = 0;
  let ended = false;
  let undecodable = false;
  let line = "";
  let long = false;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const buffer = new Uint8Array(65536);
  const take = (text) => {
    const parts = text.split("\n");
    for (let index = 0; parts.length > index; index += 1) {
      const part = parts[index];
      if (!long) {
        line += part;
        if (line.length > LINE) {
          line = line.slice(0, LINE);
          long = true;
          state.clipped += 1;
        }
      }
      if (parts.length - 1 > index) {
        classify(state, line.replace(ESCAPE, ""));
        line = "";
        long = false;
      }
    }
  };
  try {
    while (CEILING > bytes) {
      const count = await file.read(buffer.subarray(0, Math.min(buffer.length, CEILING - bytes)));
      if (count === null) {
        ended = true;
        break;
      }
      bytes += count;
      take(decoder.decode(buffer.subarray(0, count), { stream: true }));
    }
    if (!ended) {
      ended = (await file.read(new Uint8Array(1))) === null;
    }
    if (ended) {
      take(decoder.decode());
      if (line !== "") {
        classify(state, line.replace(ESCAPE, ""));
      }
    }
  } catch {
    undecodable = true;
  } finally {
    file.close();
  }
  const completeness = undecodable ? "unreadable" : !ended ? "truncated at 1 MiB" : state.rootClose === null ? "no root close" : "complete";
  const mkdir = attribution(state, replacementPath);
  const first = state.mkdirs[0];
  const roleAfter = state.role.fixture.after;
  const reserved = mkdir === "replacement" || mkdir.startsWith("replacement-first");
  const label = completeness !== "complete" ? "incomplete" : reserved ? (first === "0" ? (roleAfter > 0 ? "reserved-dispatched" : "reserved-not-dispatched") : (roleAfter > 0 ? "refused-reservation-dispatched" : "refused-reservation")) : mkdir === "none" ? (state.fail.before > 0 ? "gate-refused" : "no-reservation") : "ambiguous";
  const counts = (pair) => pair.before + "/" + pair.after;
  return [
    "trace " + completeness + " " + Math.ceil(bytes / 1024) + " KiB, events " + state.events + (state.clipped > 0 ? ", clipped lines " + state.clipped : ""),
    "class " + label,
    "probes " + (state.probes.join(",") || "none") + (state.probeCount > 8 ? " +" + (state.probeCount - 8) + " more" : ""),
    "mkdir " + (state.mkdirs.join(",") || "none") + (state.mkdirCount > 4 ? " +" + (state.mkdirCount - 4) + " more" : "") + " attributed " + mkdir,
    "before/after reservation: dispatch " + counts(state.dispatch) + ", fixture role " + counts(state.role.fixture) + ", production role " + counts(state.role.production) + ", other role " + counts(state.role.other) + ", fail " + counts(state.fail),
    "root close " + (state.rootClose ?? "absent"),
    "non-event lines " + state.nonEvent + " refusals " + (state.refusals.join("+") || "none"),
  ].join(", ");
}
async function positions(path) {
  const file = await read(path);
  if (file.state !== "read") {
    return file.state;
  }
  const calls = parsed(file.text);
  if (!Array.isArray(calls)) {
    return "unavailable";
  }
  const shown = calls.slice(0, 8).map((call) => Number.isSafeInteger(call?.position) ? String(call.position) : "?");
  return "[" + shown.join(",") + (calls.length > 8 ? ",+" + (calls.length - 8) + " more" : "") + "]";
}
async function presence(path) {
  try {
    await Deno.stat(path);
    return "yes";
  } catch (error) {
    return error instanceof Deno.errors.NotFound ? "no" : "unavailable";
  }
}
const exits = tokens === "" ? "none" : tokens.split(" ").slice(0, 4).map((token) => /^[0-9]{1,3}$/.test(token) ? token : "?").join(" ");
const waits = /^overlap-waits first=([0-9]{1,10}):([0-9]{1,3}) second=([0-9]{1,10}):([0-9]{1,3})$/m.exec(shell);
const files = [];
for (const name of ["transition.json", "execution.json", "outcome.json", "raw.txt", "receipt.json"]) {
  files.push(name + " " + await presence(replacement + "/" + name));
}
console.log([
  "exit tokens " + exits,
  waits === null ? "post-wait record absent" : "first pid " + waits[1] + " wait " + waits[2] + ", second pid " + waits[3] + " wait " + waits[4],
  "called.json positions " + await positions(called),
  "replacement directory " + await presence(replacement) + ": " + files.join(", "),
  "first stdout " + await stdoutSummary(firstOut) + ", " + await trace(firstErr, replacement),
  "second stdout " + await stdoutSummary(secondOut) + ", " + await trace(secondErr, replacement),
].join("; ").slice(0, 1800));
COLLECT
```
<Let as="evidence" value={overlapEvidence.exitCode === 0 && overlapEvidence.stdout.startsWith("exit tokens ") && 1801 > overlapEvidence.stdout.trim().length && !overlapEvidence.stdout.trim().includes("\n") ? overlapEvidence.stdout.trim() : "fixture evidence unavailable"} />
<AssertEquals actual={zeroExits} expected={1} msg={"Delivery A-H turn-failed overlap: zero exits " + zeroExits + ", expected 1; " + evidence} />
<Else>
<AssertEquals actual={zeroExits} expected={1} />
</Else>
</If>
<Fixture.Observed delivery={delivery.directory} root={fixture.root} as="afterOverlap" />
<AssertEquals actual={afterOverlap.calls.map(call => call.position)} expected={[0,1,1]} />
<Delivery.Status delivery={delivery} number={7} as="resumed" />
<AssertEquals actual={resumed.status} expected="ready_for_merge" />
<Fixture.Inventory directory={attempt} as="afterCut" />
<AssertEquals actual={Object.keys(afterCut).filter(path => !path.includes("/replacement/")).map(path => afterCut[path])} expected={Object.keys(beforeCut).filter(path => !path.includes("/replacement/")).map(path => beforeCut[path])} />
</If>
