```bash exec as="location"
pwd -P
```
<TempDir as="identityDirectory" />
<TestAgent>
<TestAgent.Scenario session="independent-proof" src="./agents/independent-review.md" models={{selected:"fixture",options:[{id:"fixture"}]}} />
<Test name="the production review role installs the host-registered acpx provider rather than inheriting the root one" timeout="60s">
<Ticket.Capture as="execution"><Delivery.Role delivery={{directory:identityDirectory + "/delivery",repository:location.stdout.trim(),policy:{reviewer:{provider:"test",model:"fixture",effort:null,session:"independent-proof"},acceptance:[{id:"behavior",source:"accepted.md",requirement:"Keep the accepted behavior."}]},inputs:[{path:"accepted.md",content:"The original accepted behavior."}]}} revision={"a".repeat(40)} reviewer={{provider:"test",model:"fixture",effort:null,session:"independent-proof"}} choices={["fixture"]} position={0} attempt={identityDirectory + "/delivery/review-attempt"} as="outcome" /><Json value={outcome} /></Ticket.Capture>
<AssertEquals actual={execution.status} expected="failed" />
<AssertStringIncludes actual={execution.failure} expected={'Unknown agent provider "acpx"'} />
<Dir path={identityDirectory + "/delivery"}><Glob include={["**"]} as="written" /></Dir>
<AssertEquals actual={written} expected={[]} />
</Test>
</TestAgent>

<TestAgent agent="claude">
<TestAgent.Scenario session="initialized-implementor" src="./agents/initialized-role.md" models={{selected:"opus",options:[{id:"opus",efforts:{selected:"high",options:["high"]}}]}} />
<Test name="the production role dispatches mandatory initialization but refuses an oversized request before prompting" timeout="60s">
<Let as="assessment" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"Inspect the agreed behavior.",evidence:["accepted.md"]}} />
<Let as="assignment" value={{identityDirectory,phase:"implementation",work:"test",repository:location.stdout.trim(),revision:"a".repeat(40),request:"Inspect saved evidence.",assessment}} />
<TempDir as="artifactDirectory" />
<Phase.SubmissionGuide repository={assignment.repository} directory={artifactDirectory}><Phase.SubmissionInstructions role="implementor" assignment={assignment} /></Phase.SubmissionGuide>
<Phase.Role role="implementor" session="initialized-implementor" assignment={{...assignment,artifactDirectory}} initialize={true} as="reply" />
<AssertStringIncludes actual={reply} expected="initialization received" />
<TempDir as="artifactDirectory" />
<Phase.SubmissionGuide repository={assignment.repository} directory={artifactDirectory}><Phase.SubmissionInstructions role="implementor" assignment={assignment} /></Phase.SubmissionGuide>
<Ticket.Capture as="oversized"><Phase.Role role="implementor" session="initialized-implementor" assignment={{...assignment,artifactDirectory,request:"x".repeat(256000)}} initialize={true} as="unexpected" /></Ticket.Capture>
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
<Let as="assignment" value={{identityDirectory,phase:"discovery",work:"test",repository:location.stdout.trim(),revision:"a".repeat(40),request:"Inspect saved evidence.",assessment}} />
<Phase.Profile role="planner" plannerProvider="codex" assessment={assessment} as="profile" />
<AssertEquals actual={profile} expected={{provider:"codex",model:"gpt-6.1-sol",effort:"medium"}} />
<TempDir as="artifactDirectory" />
<Phase.SubmissionGuide repository={assignment.repository} directory={artifactDirectory}><Phase.SubmissionInstructions role="planner" assignment={{...assignment,phase:"discovery"}} /></Phase.SubmissionGuide>
<Phase.Role role="planner" plannerProvider="codex" session="sol-planner" assignment={{...assignment,artifactDirectory}} as="planner" />
<AssertStringIncludes actual={planner} expected="Sol medium received" />
<TempDir as="artifactDirectory" />
<Phase.SubmissionGuide repository={assignment.repository} directory={artifactDirectory}><Phase.SubmissionInstructions role="planner" assignment={{...assignment,phase:"review"}} /></Phase.SubmissionGuide>
<Phase.Role role="planner" plannerProvider="codex" session="sol-planner" assignment={{...assignment,artifactDirectory,phase:"review"}} as="continued" />
<AssertStringIncludes actual={continued} expected="Sol medium continued" />
<TempDir as="artifactDirectory" />
<Phase.SubmissionGuide repository={assignment.repository} directory={artifactDirectory}><Phase.SubmissionInstructions role="implementor" assignment={{...assignment,phase:"implementation"}} /></Phase.SubmissionGuide>
<Phase.Role role="implementor" implementationProvider="codex" session="sol-implementor" assignment={{...assignment,artifactDirectory,phase:"implementation"}} as="implementor" />
<AssertStringIncludes actual={implementor} expected="Sol medium received" />
<TempDir as="artifactDirectory" />
<Phase.SubmissionGuide repository={assignment.repository} directory={artifactDirectory}><Phase.SubmissionInstructions role="planner" assignment={{...assignment,phase:"discovery"}} /></Phase.SubmissionGuide>
<Phase.Role role="planner" plannerProvider="claude" session="opus-planner" assignment={{...assignment,artifactDirectory}} as="claude" />
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
<Let as="assignment" value={{artifactDirectory:attempt,identityDirectory:temporary.stdout.trim() + "/sessions",phase:"review",work:"test",repository,revision:head.stdout.trim(),priorRevision:null,request:"Inspect the saved verdict.",assessment,artifacts:[],evidence:[],findings:[],changedPaths:[],continuation:{phase:"ready",role:null}}} />
<Let as="raw" value={JSON.stringify({schema:"phase-result.v2",phase:"review",work:"test",outcome:"pass",revision:assignment.revision,summary:"x".repeat(1201),handoff:"Inspect the saved verdict.",artifacts:[],evidence:[],findings:[],assessment,next:{phase:"ready",role:null},discoveryRequests:[],discoveryGaps:[]})} />
<Dir path={attempt}><File path="assignment.json"><Json value={assignment} /></File><File path="raw.txt">{raw}</File></Dir>
<Phase.SubmissionGuide repository={repository} directory={attempt}><Phase.SubmissionInstructions role="planner" assignment={assignment} /></Phase.SubmissionGuide>
<TestAgent agent="codex">
<TestAgent.Scenario session="original-sol-reviewer" src="./agents/sol-correction.md" models={{selected:"fixture-default",options:[{id:"fixture-default"},{id:"gpt-6.1-sol",efforts:{selected:"high",options:["medium","high"]}}]}} />
<Agent name="codex"><Session name="original-sol-reviewer" model="gpt-6.1-sol" effort="medium"><Phase.Session directory={assignment.identityDirectory} name="original-sol-reviewer" /></Session></Agent>
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
<Let as="assignment" value={{identityDirectory:temporary.stdout.trim() + "/sessions",phase:"implementation",work:original.work,repository,revision:head.stdout.trim(),priorRevision:null,request:JSON.stringify(original),assessment,artifacts:[],evidence:[],findings:[],changedPaths:[],continuation:{phase:"review",role:"planner"}}} />
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

<Test name="A2 production instructions and schema distinguish actual author from requested successor">
<Let as="assignment" value={{identityDirectory,phase:"discovery",work:"ordinary",repository:location.stdout.trim(),revision:"a".repeat(40),request:"Ask the original Architect for the missing boundary.",continuation:{phase:"implementation",role:"implementor"}}} />
<Let as="instructions"><Phase.Instructions role="planner" assignment={assignment} submission={{path:"/frozen/submission-guide.md"}} /></Let>
<AssertStringIncludes actual={instructions} expected="discoveryRequests[].role and discoveryGaps[].request.role equal to planner" />
<AssertStringIncludes actual={instructions} expected="next.role names the requested successor" />
<Let as="submission"><Phase.SubmissionInstructions role="planner" assignment={assignment} /></Let>
<Let as="schemaText" value={submission.slice(submission.lastIndexOf('\n{'))} />
<Parse schema={{type:"object"}} as="schema">{schemaText}</Parse>
<AssertEquals actual={schema.properties.discoveryRequests.items.properties.role} expected={{const:"planner"}} />
<AssertEquals actual={schema.properties.discoveryGaps.items.properties.request.properties.role} expected={{const:"planner"}} />
<AssertEquals actual={schema.$defs.route.properties.role.enum.includes("architect")} expected={true} />
</Test>

<Test name="A2 sanitized incident fixtures retain rejected historical dispositions">
<Ticket.Text path={location.stdout.trim() + "/examples/adversarial-implementation/tests/fixtures/initial-planning-incidents.json"} as="text" />
<Parse schema={{type:"array"}} as="incidents">{text}</Parse>
<AssertEquals actual={incidents.map(incident => incident.issue)} expected={[1075,1081]} />
<AssertEquals actual={incidents.every(incident => incident.validationCode === "metadata-8" && !incident.canonicalResultCreated && !incident.implementationStarted && !incident.rawRewritten && incident.responseCorrections === 0 && incident.source.startsWith("/private/tmp/"))} expected={true} />
</Test>


<Test name="the frozen submission guide matches each role's exact phase contract">
<Each in={[{role:"architect",phase:"discovery"},{role:"planner",phase:"discovery"},{role:"implementor",phase:"implementation"},{role:"architect",phase:"review"},{role:"planner",phase:"review"}]} let="selected">
<TempDir as="artifactDirectory" />
<Let as="assignment" value={{phase:selected.phase,work:"submission-" + selected.role,repository:location.stdout.trim(),artifactDirectory,revision:"a".repeat(40),request:"Inspect saved evidence."}} />
<Phase.SubmissionGuide repository={assignment.repository} directory={artifactDirectory}><Phase.SubmissionInstructions role={selected.role} assignment={assignment} /></Phase.SubmissionGuide>
<Phase.Request role={selected.role} assignment={assignment} as="request" />
<AssertEquals actual={request.includes('"$defs"') || request.includes("Return assessment on completed implementation")} expected={false} />
<AssertStringIncludes actual={request} expected={artifactDirectory + "/submission-guide.md"} />
<Let as="expected"><Phase.SubmissionInstructions role={selected.role} assignment={assignment} /></Let>
<Ticket.Text path={artifactDirectory + "/submission-guide.md"} as="saved" />
<AssertEquals actual={saved.trim()} expected={expected.trim()} />
<Let as="schemaText" value={saved.slice(saved.lastIndexOf('\n{'))} />
<Parse schema={{type:"object"}} as="schema">{schemaText}</Parse>
<AssertEquals actual={schema.properties.phase} expected={{const:selected.phase}} />
<AssertEquals actual={schema.properties.work} expected={{const:assignment.work}} />
<AssertEquals actual={schema.properties.discoveryRequests.items.properties.role} expected={{const:selected.role}} />
<AssertEquals actual={Object.hasOwn(schema.properties,"contract")} expected={selected.role === "architect" && selected.phase === "discovery"} />
<AssertEquals actual={schema.required.includes("revision")} expected={selected.phase === "implementation"} />
<Ticket.Capture as="occupied"><Phase.SubmissionGuide repository={assignment.repository} directory={artifactDirectory}><Phase.SubmissionInstructions role={selected.role} assignment={assignment} /></Phase.SubmissionGuide></Ticket.Capture>
<AssertEquals actual={occupied.status} expected="failed" />
<AssertStringIncludes actual={occupied.failure} expected="submission guide is occupied" />
</Each>
</Test>

<Test name="early blockers use one native call and damaged submission guides cannot admit a result" timeout="90s">
<Each in={["blocked","changed","missing","unreadable","invalid","correction-changed"]} let="variant">
<TempDir as="directory" />
<Let as="repository" value={location.stdout.trim()} />
<Let as="quoted" value={"'" + repository.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="head"
git -C {quoted} rev-parse HEAD
```
<Let as="attempt" value={directory + "/attempt"} />
<Let as="assessment" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"Inspect the accepted behavior.",evidence:["accepted.md"]}} />
<Let as="assignment" value={{phase:"review",work:"submission-guide",repository,revision:head.stdout.trim(),priorRevision:null,request:variant,assessment,artifacts:[],evidence:[],findings:[],changedPaths:[],continuation:{phase:"ready",role:null}}} />
<NativeGuide variant={variant}>
<TestAgent agent="codex">
<TestAgent.Scenario session="submission-result" src="./agents/submission-result.md" models={{selected:"gpt-6.1-sol",options:[{id:"gpt-6.1-sol",efforts:{selected:"medium",options:["medium"]}}]}} />
<Ticket.Capture as="execution"><Phase.Run phase="review" role="planner" session="submission-result" plannerProvider="codex" assignment={assignment} attempt={attempt} responseProfile={{kind:"ticket",knownDocuments:[]}} maxResponseCorrections={variant === "correction-changed" ? 1 : 0} as="result" /><Json value={result} /></Ticket.Capture>
</TestAgent>
</NativeGuide>
<If condition={variant === "blocked" && execution.status !== "completed"}><Fail message={execution.failure} /></If>
<AssertEquals actual={execution.status} expected={variant === "blocked" ? "completed" : "failed"} />
<Ticket.Text path={attempt + "/raw.txt"} as="raw" />
<AssertEquals actual={raw.length > 0} expected={true} />
<Ticket.Text path={attempt + "/delivery.json"} as="deliveryText" />
<Parse schema={{type:"object"}} as="delivery">{deliveryText}</Parse>
<AssertEquals actual={delivery.raw} expected={attempt + "/raw.txt"} />
<Dir path={attempt}><Glob include={["result.json","response-acceptance.json"]} as="canonical" /><Glob include={["response-corrections/**/request.json"]} as="corrections" /></Dir>
<AssertEquals actual={canonical.length} expected={variant === "blocked" ? 2 : 0} />
<AssertEquals actual={corrections.length} expected={variant === "correction-changed" ? 1 : 0} />
<If condition={variant === "correction-changed"}><Ticket.Text path={attempt + "/response-corrections/0001/raw.txt"} as="correctedRaw" /><AssertEquals actual={correctedRaw.length > 0} expected={true} /></If>
<If condition={variant === "blocked"}>
<Parse schema={{type:"object"}} as="result">{execution.output}</Parse>
<AssertEquals actual={result.outcome} expected="blocked" />
<AssertEquals actual={result.next} expected={{phase:"hold",role:null}} />
<AssertEquals actual={result.revision} expected={head.stdout.trim()} />
</If>
</Each>
</Test>


<Test name="unavailable or altered submission guides refuse a prepared request before dispatch">
<Each in={["changed","missing","unreadable"]} let="variant">
<TempDir as="artifactDirectory" />
<Let as="assignment" value={{phase:"review",work:"guide-preflight",repository:location.stdout.trim(),artifactDirectory,revision:"a".repeat(40),request:"Inspect saved evidence."}} />
<Phase.SubmissionGuide repository={assignment.repository} directory={artifactDirectory}><Phase.SubmissionInstructions role="planner" assignment={assignment} /></Phase.SubmissionGuide>
<Dir path={artifactDirectory}>
<If condition={variant === "changed"}><File path="submission-guide.md">Changed before dispatch.</File><Else><File.Delete path="submission-guide.md" /></Else></If>
<If condition={variant === "unreadable"}><Dir path="submission-guide.md"><File path="entry">A directory cannot supply the guide.</File></Dir></If>
</Dir>
<Ticket.Capture as="refused"><Phase.Request role="planner" assignment={assignment} as="unexpected" /></Ticket.Capture>
<AssertEquals actual={refused.status} expected="failed" />
</Each>
</Test>
