```bash exec as="location"
pwd -P
```
<Test name="A1 the explicit Implementor model changes only the Implementor and omission keeps the default profile">
<Let as="assessment" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"Inspect accepted behavior.",evidence:["accepted.md"]}} />
<Phase.Profile role="implementor" implementationProvider="claude" assessment={assessment} as="claudeDefault" />
<AssertEquals actual={claudeDefault} expected={{provider:"claude",model:"opus",effort:"high"}} />
<Phase.Profile role="implementor" implementationProvider="claude" implementationModel="sonnet" assessment={assessment} as="claudeSonnet" />
<AssertEquals actual={claudeSonnet} expected={{provider:"claude",model:"sonnet",effort:"high"}} />
<Phase.Profile role="implementor" implementationProvider="codex" assessment={assessment} as="codexDefault" />
<AssertEquals actual={codexDefault} expected={{provider:"codex",model:"gpt-6.1-sol",effort:"medium"}} />
<Phase.Profile role="implementor" implementationProvider="codex" implementationModel="other-model" assessment={assessment} as="codexSelected" />
<AssertEquals actual={codexSelected} expected={{provider:"codex",model:"other-model",effort:"medium"}} />
<Each in={["claude","codex"]} let="provider">
<Phase.Profile role="planner" plannerProvider={provider} assessment={assessment} as="plannerDefault" />
<Phase.Profile role="planner" plannerProvider={provider} implementationModel="sonnet" assessment={assessment} as="plannerSelected" />
<AssertEquals actual={plannerSelected} expected={plannerDefault} />
</Each>
<Phase.Profile role="architect" implementationModel="sonnet" assessment={assessment} as="architectSelected" />
<Phase.Profile role="architect" assessment={assessment} as="architectDefault" />
<AssertEquals actual={architectSelected} expected={architectDefault} />
</Test>

<Test name="A2 A3 an explicit Sonnet Implementor is configured before its prompt, delivered and retained through a response correction" timeout="60s">
<Each in={["selected","absent"]} let="variant">
<TempDir>
<Let as="repository" value={location.stdout.trim()} />
<Let as="quoted" value={"'" + repository.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="head"
git -C {quoted} rev-parse HEAD
```
```bash exec as="temporary"
pwd -P
```
<Let as="witness" value={temporary.stdout.trim() + "/failed-check.json"} />
<File path="failed-check.json">{"{}"}</File>
<Let as="assessment" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"The consumer requires a missing API operation.",evidence:[witness]}} />
<Let as="apiConflict" value={{expected:"The API provides the consumer operation.",observed:"The focused consumer check fails without it.",reproducer:"Run the saved consumer check.",artifact:witness}} />
<Let as="original" value={{schema:"phase-result.v2",phase:"implementation",work:"sonnet-" + variant,outcome:"needs_discovery",revision:head.stdout.trim(),summary:"The existing API cannot express the consumer.",handoff:"Planner: repair the original API conflict.",artifacts:[witness],evidence:[{revision:head.stdout.trim(),command:"false",outcome:"failed",artifact:witness}],findings:["The required consumer operation is missing."],assessment,apiConflict,next:{phase:"discovery",role:"planner"},handoffInputs:["unrecorded.md"],discoveryRequests:[],discoveryGaps:[]}} />
<Let as="assignment" value={{identityDirectory:temporary.stdout.trim() + "/sessions",phase:"implementation",work:original.work,repository,revision:head.stdout.trim(),priorRevision:null,request:JSON.stringify(original),assessment,artifacts:[],evidence:[],findings:[],changedPaths:[],continuation:{phase:"review",role:"planner"}}} />
<Let as="attempt" value={temporary.stdout.trim() + "/response"} />
<TestAgent agent="claude">
<TestAgent.Scenario session="original-sonnet-implementor" src="./agents/sonnet-correction.md" models={{selected:"fixture-default",options:variant === "selected" ? [{id:"fixture-default"},{id:"opus",efforts:{selected:"high",options:["high"]}},{id:"sonnet",efforts:{selected:"medium",options:["medium","high"]}}] : [{id:"fixture-default"},{id:"opus",efforts:{selected:"high",options:["high"]}}]}} />
<Ticket.Capture as="execution"><Phase.Run phase="implementation" role="implementor" session="original-sonnet-implementor" assignment={assignment} attempt={attempt} initialize={false} implementationProvider="claude" implementationModel="sonnet" responseProfile={{kind:"ticket",knownDocuments:[]}} maxResponseCorrections={1} as="result" /><Json value={result} /></Ticket.Capture>
</TestAgent>
<If condition={variant === "selected"}>
<If condition={execution.status !== "completed"}><Fail message={execution.failure} /></If>
<Ticket.Text path={attempt + "/delivery.json"} as="text" />
<Parse schema={{type:"object"}} as="delivery">{text}</Parse>
<AssertEquals actual={{role:delivery.role,session:delivery.session,provider:delivery.provider,profile:delivery.profile}} expected={{role:"implementor",session:"original-sonnet-implementor",provider:"claude",profile:{provider:"claude",model:"sonnet",effort:"high"}}} />
<Ticket.Text path={attempt + "/response-corrections/0001/request.json"} as="text" />
<Parse schema={{type:"object"}} as="packet">{text}</Parse>
<AssertEquals actual={{role:packet.role,session:packet.session,provider:packet.provider,initialize:packet.initialize,ordinal:packet.ordinal,remaining:packet.remaining}} expected={{role:"implementor",session:"original-sonnet-implementor",provider:"claude",initialize:false,ordinal:1,remaining:0}} />
<Ticket.Text path={temporary.stdout.trim() + "/sessions/original-sonnet-implementor.json"} as="identityText" />
<Parse schema={{type:"object"}} as="identity">{identityText}</Parse>
<AssertEquals actual={{agent:identity.agent,name:identity.name,attempted:identity.attempted}} expected={{agent:"claude",name:"original-sonnet-implementor",attempted:true}} />
<Else>
<AssertEquals actual={execution.status} expected="failed" />
<AssertStringIncludes actual={execution.failure} expected="Unknown model" />
<Dir path={attempt}><Glob include={["raw.txt","delivery.json","result.json","response-corrections/**"]} as="produced" /></Dir>
<AssertEquals actual={produced} expected={[]} />
</Else>
</If>
</TempDir>
</Each>
</Test>

