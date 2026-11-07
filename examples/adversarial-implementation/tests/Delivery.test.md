```bash exec as="location"
pwd -P
```
<Let as="root" value={location.stdout.trim()} />
```bash exec as="commandSetting"
printf '%s' "$XMD_EXAMPLE_COMMAND"
```
<Let as="runner" value={commandSetting.stdout || "deno run --node-modules-dir=manual --cached-only --allow-all '" + root.replaceAll("'","'\"'\"'") + "/packages/cli/src/deno.ts' run"} />
<Let as="assessment" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"Inspect the agreed behavior.",evidence:["accepted.md"]}} />

<Test name="delivery requires explicit obligations and original acceptance sources">
<Let as="task" value={{work:"test",repository:"/source",directory:"/work",inputs:["accepted.md"],sessions:{planner:"planner",implementor:"implementor",architect:"architect"}}} />
<Let as="policy" value={{repository:"taras/executable.md",reviewer:{provider:"claude",model:"fixture",effort:null,session:"independent"},acceptance:[{id:"behavior",source:"accepted.md",requirement:"Keep the accepted behavior."}]}} />
<Each in={[{},policy,{...policy,reviewer:{...policy.reviewer,session:"implementor"}},{...policy,acceptance:[]},{...policy,acceptance:[{...policy.acceptance[0],source:"invented-gate.md"}]},{...policy,acceptance:[policy.acceptance[0],policy.acceptance[0]]}]} let="candidate">
<Ticket.Capture as="execution"><Delivery.Prepare task={{...task,delivery:candidate}} inputs={[{path:"accepted.md",content:"The original behavior."}]} as="prepared" /><Json value={prepared} /></Ticket.Capture>
<AssertEquals actual={execution.status === "completed"} expected={JSON.stringify(candidate) === JSON.stringify(policy)} />
</Each>
</Test>

<Test name="joined exact-head review is necessary and its verdict drives the next action" timeout="90s">
<Each in={["pass","repair","blocked","wrong-head","missing-clause","false-pass","failed","unjoined","empty"]} let="scenario">
<TempDir>
<Fixture.Repository as="fixture" />
<Fixture.Entry entry="delivery-case" value={{scenario,fixture,runner,root}} repository={fixture.repository} command={runner} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={scenario + ": " + child.stderr + child.stdout} /></If>
</TempDir>
</Each>
</Test>

<Test name="A-H required review follows Fable, one independent Astra replacement, then a retained Elicit hold" timeout="420s">
<TempDir>
<Fixture.Repository as="fixture" />
<Fixture.Entry entry="fallback-case" value={{fixture,scenarios:["fable-pass","unavailable","configuration","turn-failed","exhausted","exhausted-reconcile","exhausted-failure","interrupted","partial","unjoined-primary","outside","astra-final","repair","blocked","malformed","reserved"],runner,root}} repository={fixture.repository} command={runner} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr + child.stdout} /></If>
</TempDir>
</Test>

<Test name="CI selection shares the exact-main rule and follows newer attempts">
<Let as="revision" value={"a".repeat(40)} />
<Let as="run" value={{id:1,run_number:4,run_attempt:1,status:"completed",conclusion:"success",head_sha:revision,head_branch:"main",event:"push",name:"CI",html_url:"https://example.invalid/run/1",actor:{login:"test"}}} />
<Delivery.SelectRuns number={7} branch="codex/requested" revision={revision} mainRevision={revision} prPages={[{workflow_runs:[{...run,event:"pull_request",head_branch:"codex/requested",pull_requests:[{number:7,head:{sha:revision,ref:"codex/requested"}}]}]}]} mainPages={[{workflow_runs:[run,{...run,id:2,run_number:5,run_attempt:2,status:"in_progress",conclusion:null},{...run,id:3,run_number:99,head_sha:"b".repeat(40)},{...run,id:4,run_number:100,event:"pull_request"},{...run,id:5,run_number:101,name:"Other"}]}]} as="selected" />
<AssertEquals actual={selected.main.id} expected={2} />
<AssertEquals actual={selected.main.status} expected="in_progress" />
<AssertEquals actual={selected.ci.id} expected={1} />
</Test>

<Test name="assignment metadata is supplied without inventing evidence or replacing conflicts">
<Let as="assignment" value={{phase:"review",work:"test",revision:"a".repeat(40),continuation:{phase:"ready",role:null}}} />
<Phase.Metadata assignment={assignment} value={{outcome:"pass",evidence:[]}} as="prepared" />
<AssertEquals actual={prepared} expected={{phase:"review",work:"test",revision:assignment.revision,next:assignment.continuation,outcome:"pass",evidence:[]}} />
<Phase.Metadata assignment={assignment} value={{phase:"implementation",work:"another",revision:"b".repeat(40),outcome:"pass",next:{phase:"hold",role:null}}} as="conflicting" />
<AssertEquals actual={conflicting.work} expected="another" />
<AssertEquals actual={conflicting.revision} expected={"b".repeat(40)} />
<Phase.Metadata assignment={{...assignment,phase:"implementation"}} value={{outcome:"complete"}} as="implementation" />
<AssertEquals actual={Object.hasOwn(implementation,"revision")} expected={false} />
</Test>

<Test name="CI from another PR or an unassociated run cannot replace the requested PR's verdict">
<Let as="revision" value={"a".repeat(40)} />
<Let as="branch" value="codex/requested" />
<Let as="association" value={{number:7,head:{sha:revision,ref:branch}}} />
<Let as="run" value={{id:1,run_number:4,run_attempt:1,status:"in_progress",conclusion:null,head_sha:revision,head_branch:branch,event:"pull_request",name:"CI",html_url:"https://example.invalid/run/1",actor:{login:"test"},pull_requests:[association]}} />
<Each in={[
 {...run,id:2,run_number:10,status:"completed",conclusion:"success",head_branch:"codex/other",pull_requests:[{number:8,head:{sha:revision,ref:"codex/other"}}]},
 {...run,id:3,run_number:11,status:"completed",conclusion:"success",pull_requests:[{...association,number:8}]},
 {...run,id:4,run_number:12,status:"completed",conclusion:"success",pull_requests:[]},
 {...run,id:5,run_number:13,status:"completed",conclusion:"success",pull_requests:undefined},
 {...run,id:6,run_number:14,status:"completed",conclusion:"success",head_branch:"codex/other"},
 {...run,id:7,run_number:15,status:"completed",conclusion:"success",head_sha:"b".repeat(40)},
 {...run,id:8,run_number:16,status:"completed",conclusion:"success",pull_requests:[{...association,head:{sha:"b".repeat(40),ref:branch}}]},
 {...run,id:9,run_number:17,status:"completed",conclusion:"success",pull_requests:[{...association,head:{sha:revision,ref:"codex/other"}}]}
]} let="unrelated">
<Each in={["in_progress","completed"]} let="status">
<Delivery.SelectRuns number={7} branch={branch} revision={revision} mainRevision={revision} prPages={[{workflow_runs:[{...run,status,conclusion:status === "completed" ? "failure" : null}]},{workflow_runs:[unrelated]}]} mainPages={[]} as="selected" />
<AssertEquals actual={selected.ci.id} expected={1} />
<AssertEquals actual={selected.ci.status} expected={status} />
<AssertEquals actual={selected.ci.conclusion} expected={status === "completed" ? "failure" : null} />
</Each>
<Delivery.SelectRuns number={7} branch={branch} revision={revision} mainRevision={revision} prPages={[{workflow_runs:[unrelated]}]} mainPages={[]} as="missing" />
<AssertEquals actual={missing.ci} expected={null} />
</Each>
<Delivery.SelectRuns number={7} branch={branch} revision={revision} mainRevision={revision} prPages={[{workflow_runs:[{...run,id:10,run_number:5},{...run,id:11,run_number:5,run_attempt:2,status:"completed",conclusion:"success"},{...run,id:12,run_attempt:9}]}]} mainPages={[]} as="retried" />
<AssertEquals actual={retried.ci.id} expected={11} />
<AssertEquals actual={retried.ci.attempt} expected={2} />
</Test>

<Test name="mandatory initialization and a full selected evidence packet fit the complete prompt">
<Each in={["architect","planner","implementor"]} let="role">
<Let as="assignment" value={{phase:role === "implementor" ? "implementation" : "discovery",work:"test",repository:root,revision:"a".repeat(40),request:"Inspect saved evidence.",assessment}} />
<Phase.Request role={role} assignment={assignment} initialize={true} inputs={[{path:"accepted.md",content:"x".repeat(64000)}]} as="request" />
<AssertEquals actual={request.includes("Repository instructions:")} expected={true} />
<AssertEquals actual={request.includes("Role instructions:")} expected={true} />
<AssertEquals actual={request.includes("You are the repository " + role)} expected={true} />
<AssertEquals actual={request.includes("x".repeat(64000))} expected={true} />
</Each>
</Test>

<Test name="review summary accepts 1500 characters and refuses 1501">
<Delivery.Schema as="schemas" />
<Let as="review" value={{revision:"a".repeat(40),verdict:"pass",summary:"x".repeat(1500),acceptance:["behavior"],findings:[]}} />
<SafeParse schema={schemas.review} as="accepted"><Json value={review} /></SafeParse>
<AssertEquals actual={accepted.ok} expected={true} />
<SafeParse schema={schemas.review} as="rejected"><Json value={{...review,summary:"x".repeat(1501)}} /></SafeParse>
<AssertEquals actual={rejected.ok} expected={false} />
</Test>

<Test name="session continuity refuses changed keys, typed identities and missing established receipts before content">
<TempDir>
```bash exec as="temporaryDirectory"
pwd -P
```
<Let as="directory" value={temporaryDirectory.stdout.trim()} />
<Let as="original" value={{sessionKey:"original-adapter-key",cwd:"/source",identity:{kind:"fixture.native",value:"original-native"}}} />
<Fixture.Session session={original}><Phase.Session directory={directory} name="reviewer">first</Phase.Session></Fixture.Session>
<Ticket.Text path={directory + "/reviewer.json"} as="first" />
<Fixture.Session session={original}><Phase.Session directory={directory} name="reviewer" requireExisting={true}>continued</Phase.Session></Fixture.Session>
<Each in={[{...original,sessionKey:"changed-adapter-key"},{...original,identity:{kind:"fixture.native",value:"fresh-native"}},{...original,cwd:"/other-source"},{sessionKey:original.sessionKey,cwd:original.cwd}]} let="changed">
<Ticket.Capture as="refused"><Fixture.Session session={changed}><Phase.Session directory={directory} name="reviewer" requireExisting={true}><Fail message="PROMPT CONTENT WAS EXPANDED" /></Phase.Session></Fixture.Session></Ticket.Capture>
<AssertEquals actual={refused.status} expected="failed" />
<AssertStringIncludes actual={refused.failure} expected="session identity changed" />
<Ticket.Text path={directory + "/reviewer.json"} as="retained" />
<AssertEquals actual={retained} expected={first} />
</Each>
<Ticket.Text path={directory + "/reviewer.json.mismatch.json"} as="firstMismatch" />
<Ticket.Capture as="again"><Fixture.Session session={{...original,cwd:"/again"}}><Phase.Session directory={directory} name="reviewer"><Fail message="PROMPT CONTENT WAS EXPANDED" /></Phase.Session></Fixture.Session></Ticket.Capture>
<Ticket.Text path={directory + "/reviewer.json.mismatch.json"} as="sameMismatch" />
<AssertEquals actual={sameMismatch} expected={firstMismatch} />
<Ticket.Capture as="missing"><Fixture.Session session={original}><Phase.Session directory={directory} name="missing-reviewer" requireExisting={true}><Fail message="PROMPT CONTENT WAS EXPANDED" /></Phase.Session></Fixture.Session></Ticket.Capture>
<AssertStringIncludes actual={missing.failure} expected="identity receipt is unavailable" />
<File path="old.json">{"agent":"fixture","name":"old","sessionKey":"old","cwd":"/source","nativeId":"old-native","attempted":true,"started":null}</File>
<Ticket.Text path={directory + "/old.json"} as="oldBytes" />
<Ticket.Capture as="oldRefusal"><Fixture.Session session={original}><Phase.Session directory={directory} name="old"><Fail message="PROMPT CONTENT WAS EXPANDED" /></Phase.Session></Fixture.Session></Ticket.Capture>
<AssertEquals actual={oldRefusal.status} expected="failed" />
<Ticket.Text path={directory + "/old.json"} as="oldUnchanged" />
<AssertEquals actual={oldUnchanged} expected={oldBytes} />
</TempDir>
</Test>

<Test name="session identity learns the provider assertion beyond a frozen placement and retains it after failure">
<TempDir>
```bash exec as="temporaryDirectory"
pwd -P
```
<Let as="directory" value={temporaryDirectory.stdout.trim()} />
<Each in={[false,true]} let="fail">
<Let as="name" value={fail ? "failed" : "joined"} />
<Ticket.Capture as="turn"><Fixture.Session session={{sessionKey:name,cwd:"/source"}} startedIdentity={{kind:"fixture.native",value:"native-" + name}} laterIdentity={{kind:"fixture.native",value:"later"}} fail={fail}><Phase.Session directory={directory} name={name}><Prompt throwOnError={true}>fixture</Prompt><Prompt throwOnError={true}>second</Prompt></Phase.Session></Fixture.Session></Ticket.Capture>
<If condition={!fail && turn.status !== "completed"}><Fail message={turn.failure} /></If>
<AssertEquals actual={turn.status} expected={fail ? "failed" : "completed"} />
<Ticket.Text path={directory + "/" + name + ".json"} as="savedText" />
<Parse schema={{type:"object"}} as="saved">{savedText}</Parse>
<AssertEquals actual={saved.schema} expected="phase-session.v2" />
<AssertEquals actual={saved.identity} expected={{kind:"fixture.native",value:"native-" + name}} />
<AssertEquals actual={saved.started} expected={{sessionKey:name,cwd:"/source",identity:{kind:"fixture.native",value:"native-" + name}}} />
</Each>
</TempDir>
</Test>

<Test name="an uncertain attempted call holds without rebinding or prompting a replacement">
<TempDir>
```bash exec as="temporaryDirectory"
pwd -P
```
<Let as="directory" value={temporaryDirectory.stdout.trim()} />
<Ticket.Capture as="firstFailure"><Fixture.Session session={{sessionKey:"uncertain",cwd:"/source"}} failBeforeStarted={true}><Phase.Session directory={directory} name="uncertain"><Prompt throwOnError={true}>first attempt</Prompt></Phase.Session></Fixture.Session></Ticket.Capture>
<AssertEquals actual={firstFailure.status} expected="failed" />
<File path="first-failure.json"><Json value={firstFailure} /></File>
<Ticket.Text path={directory + "/uncertain.json"} as="firstReceipt" />
<Parse schema={{type:"object"}} as="unknown">{firstReceipt}</Parse>
<AssertEquals actual={{attempted:unknown.attempted,identity:unknown.identity,started:unknown.started}} expected={{attempted:true,identity:null,started:null}} />
<Ticket.Capture as="continuation"><Fixture.Session session={{sessionKey:"uncertain",cwd:"/source",identity:{kind:"fixture.native",value:"replacement-native"}}}><Phase.Session directory={directory} name="uncertain" requireExisting={true}><Fail message="PROMPT CONTENT WAS EXPANDED" /></Phase.Session></Fixture.Session></Ticket.Capture>
<AssertEquals actual={continuation.status} expected="failed" />
<AssertStringIncludes actual={continuation.failure} expected="attempted without a confirmed identity" />
<Ticket.Text path={directory + "/uncertain.json"} as="unchanged" />
<AssertEquals actual={unchanged} expected={firstReceipt} />
<Ticket.Text path={directory + "/first-failure.json"} as="failureText" />
<Parse schema={{type:"object"}} as="preserved">{failureText}</Parse>
<AssertEquals actual={preserved} expected={firstFailure} />
</TempDir>
</Test>
