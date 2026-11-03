```bash exec as="location"
pwd -P
```
<TestAgent>
<TestAgent.Scenario session="independent-proof" src="./agents/independent-review.md" models={{selected:"fixture",options:[{id:"fixture"}]}} />
<Test name="the production review role returns the actual configured prompt reply" timeout="60s">
<Delivery.Role delivery={{repository:location.stdout.trim(),policy:{reviewer:{provider:"test",model:"fixture",effort:null,session:"independent-proof"},acceptance:[{id:"behavior",source:"accepted.md",requirement:"Keep the accepted behavior."}]},inputs:[{path:"accepted.md",content:"The original accepted behavior."}]}} revision={"a".repeat(40)} as="reply" />
<Delivery.Schema as="schemas" />
<Parse schema={schemas.review} as="review">{reply}</Parse>
<AssertEquals actual={review.revision} expected={"a".repeat(40)} />
<AssertEquals actual={review.verdict} expected="pass" />
<AssertEquals actual={review.acceptance} expected={["behavior"]} />
</Test>
</TestAgent>

<TestAgent agent="claude">
<TestAgent.Scenario session="initialized-implementor" src="./agents/initialized-role.md" models={{selected:"sonnet",options:[{id:"sonnet",efforts:{selected:"high",options:["high"]}}]}} />
<Test name="the production role dispatches mandatory initialization but refuses an oversized request before prompting" timeout="60s">
<Let as="assessment" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"Inspect the agreed behavior.",evidence:["accepted.md"]}} />
<Let as="assignment" value={{phase:"implementation",work:"test",repository:location.stdout.trim(),revision:"a".repeat(40),request:"Inspect saved evidence.",assessment}} />
<Phase.Role role="implementor" session="initialized-implementor" assignment={assignment} initialize={true} as="reply" />
<AssertStringIncludes actual={reply} expected="initialization received" />
<Ticket.Capture as="oversized"><Phase.Role role="implementor" session="initialized-implementor" assignment={{...assignment,request:"x".repeat(256000)}} initialize={true} as="unexpected" /></Ticket.Capture>
<AssertEquals actual={oversized.status} expected="failed" />
<AssertStringIncludes actual={oversized.failure} expected="complete phase prompt exceeds 256000" />
</Test>
</TestAgent>

<TestAgent>
<TestAgent.Scenario agent="codex" session="sol-planner" src="./agents/sol-medium.md" models={{selected:"fixture-default",options:[{id:"fixture-default"},{id:"gpt-6.1-sol",efforts:{selected:"high",options:["medium","high"]}}]}} />
<TestAgent.Scenario agent="codex" session="sol-implementor" src="./agents/sol-medium.md" models={{selected:"fixture-default",options:[{id:"fixture-default"},{id:"gpt-6.1-sol",efforts:{selected:"high",options:["medium","high"]}}]}} />
<TestAgent.Scenario agent="codex" session="sol-foundation" src="./agents/sol-high.md" models={{selected:"fixture-default",options:[{id:"fixture-default"},{id:"gpt-6.1-sol",efforts:{selected:"medium",options:["medium","high"]}}]}} />
<TestAgent.Scenario agent="claude" session="opus-planner" src="./agents/opus-medium.md" models={{selected:"fixture-default",options:[{id:"fixture-default"},{id:"opus",efforts:{selected:"high",options:["medium","high"]}}]}} />
<TestAgent.Scenario agent="claude" session="opus-foundation" src="./agents/opus-high.md" models={{selected:"fixture-default",options:[{id:"fixture-default"},{id:"opus",efforts:{selected:"medium",options:["medium","high"]}}]}} />
<Test name="production role dispatch honors the selected provider and fixed profile" timeout="60s">
<Let as="assessment" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"Inspect accepted behavior.",evidence:["accepted.md"]}} />
<Let as="assignment" value={{phase:"discovery",work:"test",repository:location.stdout.trim(),revision:"a".repeat(40),request:"Inspect saved evidence.",assessment}} />
<Phase.Profile role="planner" plannerProvider="codex" assessment={assessment} as="profile" />
<AssertEquals actual={profile} expected={{provider:"codex",model:"gpt-6.1-sol",effort:"medium"}} />
<Phase.Role role="planner" plannerProvider="codex" session="sol-planner" assignment={assignment} as="planner" />
<AssertStringIncludes actual={planner} expected="Sol medium received" />
<Phase.Role role="planner" plannerProvider="codex" session="sol-planner" assignment={{...assignment,phase:"review"}} as="continued" />
<AssertStringIncludes actual={continued} expected="Sol medium continued" />
<Phase.Role role="implementor" implementationProvider="codex" session="sol-implementor" assignment={{...assignment,phase:"implementation"}} as="implementor" />
<AssertStringIncludes actual={implementor} expected="Sol medium received" />
<Phase.Role role="planner" plannerProvider="claude" session="opus-planner" assignment={assignment} as="claude" />
<AssertStringIncludes actual={claude} expected="Opus medium received" />
<Each in={["codex","claude"]} let="provider">
<Phase.Profile role="planner" plannerProvider={provider} design={true} assessment={assessment} as="foundation" />
<AssertEquals actual={foundation.provider} expected={provider} />
<AssertEquals actual={foundation.effort} expected="high" />
<Adversarial.PlannerRole assignment={{...assignment,session:provider === "codex" ? "sol-foundation" : "opus-foundation",plannerProvider:provider,initialize:false}} guide="Existing foundation instructions." as="reply" />
<AssertStringIncludes actual={reply} expected={provider === "codex" ? "Sol high received" : "Opus high received"} />
<Adversarial.PlannerRole assignment={{...assignment,session:provider === "codex" ? "sol-foundation" : "opus-foundation",plannerProvider:provider,initialize:false}} guide="" correction={{ordinal:1,remaining:0}} as="repaired" />
<AssertStringIncludes actual={repaired} expected={provider === "codex" ? "Sol high repaired" : "Opus high repaired"} />
</Each>
</Test>
</TestAgent>

<Test name="production response repair uses its original Codex owner and selected allowance" timeout="60s">
<Each in={[0,1]} let="limit">
<TempDir>
<Let as="repository" value={location.stdout.trim()} />
<Let as="quoted" value={"'" + repository.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="head"
git -C {quoted} rev-parse HEAD
```
```bash exec as="temporary"
pwd -P
```
<Let as="attempt" value={temporary.stdout.trim() + "/response"} />
<Let as="assessment" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"Inspect accepted behavior.",evidence:["accepted.md"]}} />
<Let as="assignment" value={{phase:"review",work:"test",repository,revision:head.stdout.trim(),priorRevision:null,request:"Inspect the saved verdict.",assessment,artifacts:[],evidence:[],findings:[],changedPaths:[],continuation:{phase:"ready",role:null}}} />
<Let as="raw" value={JSON.stringify({schema:"phase-result.v2",phase:"review",work:"test",outcome:"pass",revision:assignment.revision,summary:"x".repeat(1201),handoff:"Inspect the saved verdict.",artifacts:[],evidence:[],findings:[],assessment,next:{phase:"ready",role:null},discoveryRequests:[],discoveryGaps:[]})} />
<Dir path={attempt}><File path="assignment.json"><Json value={assignment} /></File><File path="raw.txt">{raw}</File></Dir>
<TestAgent agent="codex">
<TestAgent.Scenario session="original-sol-reviewer" src="./agents/sol-correction.md" models={{selected:"fixture-default",options:[{id:"fixture-default"},{id:"gpt-6.1-sol",efforts:{selected:"high",options:["medium","high"]}}]}} />
<Ticket.Capture as="execution"><Phase.Correct assignment={assignment} raw={raw} role="planner" session="original-sol-reviewer" attempt={attempt} profile={{kind:"phase",knownDocuments:[]}} plannerProvider="codex" implementationProvider="claude" inputs={[]} maxResponseCorrections={limit} as="accepted" /><Json value={accepted} /></Ticket.Capture>
</TestAgent>
<If condition={limit === 1 && execution.status !== "completed"}><Fail message={execution.failure} /></If>
<AssertEquals actual={execution.status} expected={limit === 0 ? "failed" : "completed"} />
<Dir path={attempt}><Glob include={["response-corrections/**/request.json"]} as="calls" /></Dir>
<AssertEquals actual={calls.length} expected={limit} />
<If condition={limit === 1}>
<Ticket.Text path={attempt + "/response-corrections/0001/request.json"} as="text" />
<Parse schema={{type:"object"}} as="packet">{text}</Parse>
<AssertEquals actual={packet.provider} expected="codex" />
<AssertEquals actual={packet.session} expected="original-sol-reviewer" />
<AssertEquals actual={packet.remaining} expected={0} />
<Parse schema={{type:"object"}} as="accepted">{execution.output}</Parse>
<AssertEquals actual={accepted.round} expected={1} />
</If>
</TempDir>
</Each>
</Test>

<Test name="response-only repair preserves the original Implementor API conflict" timeout="60s">
<Each in={["retained","changed","removed"]} let="variant">
<TempDir>
<Let as="repository" value={location.stdout.trim()} />
<Let as="quoted" value={"'" + repository.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="head"
git -C {quoted} rev-parse HEAD
```
```bash exec as="temporary"
pwd -P
```
```bash exec as="check"
false
```
<AssertEquals actual={check.exitCode} expected={1} />
<Let as="witness" value={temporary.stdout.trim() + "/failed-check.json"} />
<File path="failed-check.json"><Json value={check} /></File>
<Let as="assessment" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"The consumer requires a missing API operation.",evidence:[witness]}} />
<Let as="apiConflict" value={{expected:"The API provides the consumer operation.",observed:"The focused consumer check fails without it.",reproducer:"Run the saved consumer check.",artifact:witness}} />
<Let as="original" value={{schema:"phase-result.v2",phase:"implementation",work:"conflict-" + variant,outcome:"needs_discovery",revision:head.stdout.trim(),summary:"The existing API cannot express the consumer.",handoff:"Planner: repair the original API conflict.",artifacts:[witness],evidence:[{revision:head.stdout.trim(),command:"false",outcome:"failed",artifact:witness}],findings:["The required consumer operation is missing."],assessment,apiConflict,next:{phase:"discovery",role:"planner"},handoffInputs:["unrecorded.md"],discoveryRequests:[],discoveryGaps:[]}} />
<Let as="assignment" value={{phase:"implementation",work:original.work,repository,revision:head.stdout.trim(),priorRevision:null,request:JSON.stringify(original),assessment,artifacts:[],evidence:[],findings:[],changedPaths:[],continuation:{phase:"review",role:"planner"}}} />
<Let as="attempt" value={temporary.stdout.trim() + "/response"} />
<TestAgent agent="codex">
<TestAgent.Scenario session="original-conflict-implementor" src="./agents/api-conflict-correction.md" models={{selected:"fixture-default",options:[{id:"fixture-default"},{id:"gpt-6.1-sol",efforts:{selected:"high",options:["medium","high"]}}]}} />
<Ticket.Capture as="execution"><Phase.Run phase="implementation" role="implementor" session="original-conflict-implementor" assignment={assignment} attempt={attempt} initialize={false} implementationProvider="codex" responseProfile={{kind:"ticket",knownDocuments:[]}} maxResponseCorrections={1} as="result" /><Json value={result} /></Ticket.Capture>
</TestAgent>
<If condition={variant === "retained" && execution.status !== "completed"}><Fail message={execution.failure} /></If>
<AssertEquals actual={execution.status} expected={variant === "retained" ? "completed" : "failed"} />
<Ticket.Text path={attempt + "/response-rejection-0000.json"} as="text" />
<Parse schema={{type:"object"}} as="rejection">{text}</Parse>
<AssertEquals actual={rejection.code} expected="handoff-selection" />
<Ticket.Text path={attempt + "/response-corrections/0001/request.json"} as="text" />
<Parse schema={{type:"object"}} as="packet">{text}</Parse>
<AssertEquals actual={packet.established.apiConflict} expected={apiConflict} />
<AssertEquals actual={{role:packet.role,session:packet.session,provider:packet.provider,initialize:packet.initialize,ordinal:packet.ordinal,remaining:packet.remaining}} expected={{role:"implementor",session:"original-conflict-implementor",provider:"codex",initialize:false,ordinal:1,remaining:0}} />
<Dir path={attempt}><Glob include={["response-corrections/**/request.json"]} as="calls" /><Glob include={["result.json","response-acceptance.json"]} as="canonical" /></Dir>
<AssertEquals actual={calls.length} expected={1} />
<AssertEquals actual={canonical.length} expected={variant === "retained" ? 2 : 0} />
<Ticket.Text path={attempt + "/response-corrections/0001/disposition.json"} as="text" />
<Parse schema={{type:"object"}} as="disposition">{text}</Parse>
<AssertEquals actual={disposition.accepted} expected={variant === "retained"} />
<If condition={variant === "retained"}>
<Parse schema={{type:"object"}} as="result">{execution.output}</Parse>
<AssertEquals actual={result} expected={{...original,handoffInputs:[],contract:null,blocker:null}} />
<Ticket.Text path={attempt + "/response-acceptance.json"} as="text" />
<Parse schema={{type:"object"}} as="acceptance">{text}</Parse>
<AssertEquals actual={acceptance.round} expected={1} />
<Else>
<AssertEquals actual={disposition.rejection.code} expected="substantive-correspondence" />
<Ticket.Text path={attempt + "/response-disposition.json"} as="text" />
<Parse schema={{type:"object"}} as="exhausted">{text}</Parse>
<AssertEquals actual={{consumed:exhausted.consumed,limit:exhausted.limit,dispatchable:exhausted.dispatchable}} expected={{consumed:1,limit:1,dispatchable:false}} />
</Else>
</If>
</TempDir>
</Each>
</Test>
