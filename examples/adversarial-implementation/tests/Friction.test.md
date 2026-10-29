```bash exec as="location"
pwd -P
```
<Let as="root" value={location.stdout.trim()} />
```bash exec as="commandSetting"
printf '%s' "$XMD_EXAMPLE_COMMAND"
```
<Let as="runner" value={commandSetting.stdout || "deno run --allow-all '" + root.replaceAll("'","'\"'\"'") + "/packages/cli/src/deno.ts' run"} />
<Let as="assessment" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"Inspect the saved test evidence.",evidence:["intent.md"]}} />

<Test name="the phase entry carries source and selected documents and needs no SHA correction" timeout="60s">
<TempDir>
<Fixture.Repository as="fixture" />
<Dir path={fixture.repository}>
```bash exec as="observed"
git rev-parse HEAD
```
</Dir>
<Let as="checkout" value={{head:observed.stdout.trim()}} />
<Dir path={fixture.repository}><File path="guide.md">Use the saved consumer evidence.</File></Dir>
<Let as="attempt" value={fixture.root + "/review"} />
<Let as="assignment" value={{phase:"review",work:"test",repository:fixture.repository,revision:checkout.head,priorRevision:null,request:"short-revision",changedPaths:[],artifacts:[],evidence:[],findings:[],assessment,handoffInputs:["guide.md"],continuation:{phase:"ready",role:null}}} />
<Fixture.Entry entry="phase" value={{role:"planner",session:"original-planner",assignment,attempt}} command={runner} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="result">{child.stdout}</Parse>
<AssertEquals actual={result.evidence[0].revision} expected={checkout.head} />
<Ticket.Text path={attempt + "/response-acceptance.json"} as="receiptText" />
<Parse schema={{type:"object"}} as="receipt">{receiptText}</Parse>
<AssertEquals actual={receipt.round} expected={0} />
<AssertEquals actual={receipt.normalizations} expected={[{abbreviation:checkout.head.slice(0,8),revision:checkout.head}]} />
<Ticket.Text path={attempt + "/called.json"} as="calledText" />
<Parse schema={{type:"object"}} as="called">{calledText}</Parse>
<AssertEquals actual={called.inputPaths} expected={["guide.md"]} />
<Ticket.Text path={attempt + "/raw.txt"} as="original" />
<AssertStringIncludes actual={original} expected={'"revision": "' + checkout.head.slice(0,8) + '"'} />
</TempDir>
</Test>

<Test name="response correction freezes canonical evidence and still rejects substantive changes" timeout="60s">
<TempDir>
<Fixture.Repository as="fixture" />
<Dir path={fixture.repository}>
```bash exec as="observed"
git rev-parse HEAD
```
</Dir>
<Let as="checkout" value={{head:observed.stdout.trim()}} />
<Let as="attempt" value={fixture.root + "/correction"} />
<Let as="assignment" value={{phase:"review",work:"test",repository:fixture.repository,revision:checkout.head,priorRevision:null,request:"Inspect the saved evidence.",changedPaths:[],artifacts:[],evidence:[],findings:[],assessment,continuation:{phase:"ready",role:null}}} />
<Let as="reply" value={{schema:"phase-result.v2",phase:"review",work:"test",outcome:"pass",revision:checkout.head,summary:"x".repeat(1201),handoff:"Inspect the saved evidence.",artifacts:[],evidence:[{revision:checkout.head.slice(0,8),command:"saved focused test",outcome:"passed",artifact:"receipt.json"}],findings:[],next:{phase:"ready",role:null},assessment}} />
<Json value={reply} as="raw" />
<Dir path={attempt}><File path="assignment.json"><Json value={assignment} /></File><File path="raw.txt">{raw}</File></Dir>
<Dir path={fixture.repository}><Ticket.Capture as="correction"><Phase.Correct assignment={assignment} role="planner" session="original-planner" attempt={attempt} raw={raw} profile={{kind:"phase",knownDocuments:[]}} implementationProvider="claude" inputs={[]} as="accepted" /><Json value={accepted} /></Ticket.Capture></Dir>
<If condition={correction.status !== "completed"}><Ticket.Text path={attempt + "/response-rejection-0000.json"} as="rejection" /><Fail message={rejection + "\n" + correction.failure} /></If>
<Parse schema={{type:"object"}} as="accepted">{correction.output}</Parse>
<AssertEquals actual={accepted.round} expected={1} />
<AssertEquals actual={accepted.result.evidence[0].revision} expected={checkout.head} />
<Phase.Correspondence established={accepted.result} value={{...accepted.result,evidence:[{...accepted.result.evidence[0],command:"a different test"}]}} role="planner" phase="review" as="changed" />
<AssertEquals actual={changed.ok} expected={false} />
</TempDir>
</Test>

<Test name="missing, ambiguous and non-commit revisions hold without asking the role to invent evidence" timeout="60s">
<TempDir>
<Fixture.Repository as="fixture" />
<Dir path={fixture.repository}>
```bash exec as="identities"
git rev-parse HEAD:legacy.fixture
```
<Each in={["00000000",identities.stdout.trim().slice(0,8)]} let="revision">
<Phase.Revisions repository={fixture.repository} value={{revision,evidence:[]}} as="checked" />
<AssertEquals actual={checked.ok} expected={false} />
<AssertEquals actual={checked.rejection.terminal} expected={true} />
</Each>
```bash exec as="collision"
printf 'xmd revision collision 474\n' | git hash-object -w --stdin
printf 'xmd revision collision 481\n' | git hash-object -w --stdin
```
<Phase.Revisions repository={fixture.repository} value={{revision:"b7e5",evidence:[]}} as="ambiguous" />
<AssertEquals actual={ambiguous.ok} expected={false} />
<AssertStringIncludes actual={ambiguous.rejection.message} expected="does not identify one Git object" />
</Dir>
</TempDir>
</Test>

<Test name="the continuation entry preserves holds and consumed corrections" timeout="60s">
<TempDir>
<Let as="held" value={{manifest:{},checkpoint:{status:"hold",dispatchable:false,round:3,hold:{kind:"correction_bound",reason:"Inspect the saved attempts."}},calls:[{status:"rejected"}],documents:{}}} />
<Fixture.Entry entry="continue" value={held} command={runner} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="continued">{child.stdout}</Parse>
<AssertEquals actual={continued.checkpoint} expected={held.checkpoint} />
<AssertEquals actual={continued.calls} expected={held.calls} />
</TempDir>
</Test>
