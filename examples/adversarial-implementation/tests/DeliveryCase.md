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
<TempDir>
<Let as="fixture" value={input.fixture} />
<Dir path={fixture.repository}>
```bash exec as="identity"
git rev-parse HEAD
git symbolic-ref --short HEAD
```
</Dir>
<Let as="revision" value={identity.stdout.trim().split("\n")[0]} />
<Let as="branch" value={identity.stdout.trim().split("\n")[1]} />
<Let as="policy" value={{repository:"taras/executable.md",reviewer:{provider:"claude",model:"fixture",effort:null,session:"independent"},acceptance:[{id:"behavior",source:"accepted.md",requirement:"Keep the accepted behavior."}]}} />
<Delivery.Prepare task={{work:scenario,repository:fixture.repository,directory:fixture.directory,inputs:["accepted.md"],sessions:{planner:"planner",implementor:"implementor",architect:"architect"},delivery:policy}} inputs={[{path:"accepted.md",content:"The accepted original behavior."}]} as="delivery" />
<Dir path={delivery.directory}><File path="requirements.json"><Json value={delivery} /></File></Dir>
<Let as="remote" value={{revision,branch,base:"main",draft:false,state:"open",merged:false,mergeRevision:null,stable:true,ciGreen:true,ci:{status:"completed",conclusion:"success"},main:{revision,run:{status:"completed",conclusion:"success"}},mainRepair:false}} />
<File path="remote.json"><Json value={remote} /></File>
<Delivery.Status delivery={delivery} number={7} as="beforeFeedback" />
<AssertEquals actual={beforeFeedback.status} expected="feedback_pending" />
<Dir path={delivery.directory}><File path="feedback.json"><Json value={{status:"feedback_ready",revision}} /></File></Dir>
<Delivery.Status delivery={delivery} number={7} as="before" />
<AssertEquals actual={before.status} expected="review_pending" />
<AssertEquals actual={before.remaining.map(item => item.gate)} expected={["independent-review"]} />
<If condition={["unjoined","empty"].includes(scenario)}><Dir path={delivery.directory + "/review-" + revision}><If condition={scenario === "unjoined"}><File path="assignment.json"><Json value={{revision}} /></File></If></Dir></If>
<Ticket.Capture as="execution"><Delivery.Review delivery={delivery} revision={revision} as="receipt" /><Json value={receipt} /></Ticket.Capture>
<AssertEquals actual={execution.status === "completed"} expected={["pass","repair","blocked"].includes(scenario)} />
<Delivery.Status delivery={delivery} number={7} as="after" />
<AssertEquals actual={after.status} expected={scenario === "pass" ? "ready_for_merge" : scenario === "repair" ? "repair_required" : scenario === "blocked" ? "blocked" : "reconciliation_required"} />
<Ticket.Capture as="duplicate"><Delivery.Review delivery={delivery} revision={revision} as="again" /></Ticket.Capture>
<AssertEquals actual={duplicate.status} expected="failed" />
<If condition={scenario === "pass"}>
<Ticket.Text path={delivery.directory + "/called.json"} as="calledBefore" />
<Dir path={delivery.directory + "/review-" + revision}><File.Delete path="receipt.json" /></Dir>
<Delivery.Status delivery={delivery} number={7} as="unreconciled" />
<AssertEquals actual={unreconciled.status} expected="reconciliation_required" />
<Delivery.Reconcile delivery={delivery} revision={revision} publish={true} as="reconciled" />
<AssertEquals actual={reconciled.result.verdict} expected="pass" />
<Ticket.Text path={delivery.directory + "/called.json"} as="calledAfter" />
<AssertEquals actual={calledAfter} expected={calledBefore} />
<Delivery.Closeout delivery={delivery} number={7} as="closeout" />
<AssertEquals actual={closeout.status} expected="ready_for_merge" />
<Ticket.Text path={delivery.directory + "/closeout.json"} as="reportText" />
<Parse schema={{type:"object"}} as="report">{reportText}</Parse>
<AssertEquals actual={report} expected={closeout} />
<Ticket.Text path={delivery.directory + "/closeout.md"} as="reportMarkdown" />
<If condition={!reportMarkdown.includes(revision)}><Fail message={"closeout report omitted revision: " + reportMarkdown} /></If>
<If condition={!reportMarkdown.includes("await_authorized_merge")}><Fail message={"closeout report omitted next action: " + reportMarkdown} /></If>
<Dir path={fixture.repository}><File path="remote.json"><Json value={remote} /></File></Dir>
<Let as="entryArguments" value={[input.root + "/examples/adversarial-implementation/delivery.md","--props-record",delivery.directory + "/requirements.json","--props-number","7","--include",input.root + "/examples/adversarial-implementation/tests/components","--include",input.root + "/examples/adversarial-implementation/components","--raw"].map(value => "'" + value.replaceAll("'","'\"'\"'") + "'").join(" ")} />
<Dir path={delivery.directory + "/review-" + revision}><File.Delete path="receipt.json" /></Dir>
<Dir path={fixture.repository}>
```bash exec as="entryStatus"
{input.runner} {entryArguments} --props-action reconcile
```
```bash exec as="entryCloseout"
{input.runner} {entryArguments} --props-action closeout
```
```bash exec as="entryDuplicate"
{input.runner} {entryArguments} --props-action review
```
</Dir>
<If condition={entryStatus.exitCode !== 0}><Fail message={entryStatus.stderr + entryStatus.stdout} /></If>
<Parse schema={{type:"object"}} as="entry">{entryStatus.stdout}</Parse>
<AssertEquals actual={entry.status} expected="ready_for_merge" />
<If condition={entryCloseout.exitCode !== 0}><Fail message={entryCloseout.stderr + entryCloseout.stdout} /></If>
<Parse schema={{type:"object"}} as="entryReport">{entryCloseout.stdout}</Parse>
<AssertEquals actual={entryReport.status} expected="ready_for_merge" />
<AssertEquals actual={entryDuplicate.exitCode === 0} expected={false} />
<If condition={!entryDuplicate.stderr.includes("do not start another review")}><Fail message={"duplicate review returned: " + JSON.stringify(entryDuplicate)} /></If>
<Each in={[
 {change:{ci:{status:"in_progress",conclusion:null}},status:"checks_pending"},
 {change:{ci:{status:"completed",conclusion:"failure"}},status:"checks_failed"},
 {change:{ciGreen:false},status:"checks_failed"},
 {change:{main:{revision,run:{status:"in_progress",conclusion:null}}},status:"checks_pending"},
 {change:{stable:false},status:"source_changed"},
 {change:{revision:"0".repeat(40)},status:"source_changed"},
 {change:{branch:"another-branch"},status:"source_changed"},
 {change:{draft:true},status:"publication_pending"},
 {change:{state:"closed",merged:true,mergeRevision:"1".repeat(40)},status:"delivered"}
]} let="change">
<File path="remote.json"><Json value={{...remote,...change.change}} /></File>
<Delivery.Status delivery={delivery} number={7} as="changed" />
<AssertEquals actual={changed.status} expected={change.status} />
</Each>
<File path="remote.json"><Json value={remote} /></File>
<Ticket.Text path={delivery.directory + "/review-" + revision + "/receipt.json"} as="originalReceipt" />
<Parse schema={{type:"object"}} as="original">{originalReceipt}</Parse>
<Dir path={delivery.directory + "/review-" + revision}><File path="receipt.json"><Json value={{...original,result:{...original.result,summary:"A replacement claim."}}} /></File></Dir>
<Delivery.Status delivery={delivery} number={7} as="mismatched" />
<AssertEquals actual={mismatched.status} expected="reconciliation_required" />
<Ticket.Capture as="contradictory"><Delivery.Reconcile delivery={delivery} revision={revision} publish={true} as="unexpectedReceipt" /></Ticket.Capture>
<AssertEquals actual={contradictory.status} expected="failed" />
<If condition={!contradictory.failure.includes("receipt differs")}><Fail message={"contradictory reconciliation returned: " + JSON.stringify(contradictory)} /></If>
<Dir path={fixture.repository}>
<File path="legacy.fixture">A changed source after review.</File>
```bash exec as="changedSource"
git add legacy.fixture
git commit -qm 'changed after review'
```
<If condition={changedSource.exitCode !== 0}><Fail message={changedSource.stderr} /></If>
</Dir>
<Delivery.Status delivery={delivery} number={7} as="advanced" />
<AssertEquals actual={advanced.status} expected="source_changed" />
</If>
</TempDir>
