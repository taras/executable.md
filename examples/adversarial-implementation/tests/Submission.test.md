```bash exec as="location"
pwd -P
```

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
