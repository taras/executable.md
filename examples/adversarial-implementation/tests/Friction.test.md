```bash exec as="location"
pwd -P
```
<Let as="root" value={location.stdout.trim()} />
```bash exec as="commandSetting"
printf '%s' "$XMD_EXAMPLE_COMMAND"
```
<Let as="runner" value={commandSetting.stdout || "deno run --allow-all '" + root.replaceAll("'","'\"'\"'") + "/packages/cli/src/deno.ts' run --allow-absolute"} />
<Let as="assessment" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"Inspect the saved test evidence.",evidence:["intent.md"]}} />

<Test name="the phase entry carries source and selected documents and needs no SHA correction" timeout="60s">
<Each in={["short-revision","omitted-metadata"]} let="request">
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
<Let as="assignment" value={{phase:"review",work:"test",repository:fixture.repository,revision:checkout.head,priorRevision:null,request,changedPaths:[],artifacts:[],evidence:[],findings:[],assessment,handoffInputs:["guide.md"],continuation:{phase:"ready",role:null}}} />
<Fixture.Entry entry="phase" value={{role:"planner",session:"original-planner",assignment,attempt,maxResponseCorrections:0}} command={runner} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="result">{child.stdout}</Parse>
<AssertEquals actual={result.evidence[0].revision} expected={checkout.head} />
<Ticket.Text path={attempt + "/response-acceptance.json"} as="receiptText" />
<Parse schema={{type:"object"}} as="receipt">{receiptText}</Parse>
<AssertEquals actual={receipt.round} expected={0} />
<AssertEquals actual={receipt.normalizations} expected={request === "short-revision" ? [{abbreviation:checkout.head.slice(0,8),revision:checkout.head}] : []} />
<Ticket.Text path={attempt + "/called.json"} as="calledText" />
<Parse schema={{type:"object"}} as="called">{calledText}</Parse>
<AssertEquals actual={called.inputPaths} expected={["guide.md"]} />
<Ticket.Text path={attempt + "/raw.txt"} as="original" />
<AssertStringIncludes actual={original} expected={request === "short-revision" ? '"revision": "' + checkout.head.slice(0,8) + '"' : '"outcome": "pass"'} />
</TempDir>
</Each>
</Test>

<Test name="the phase response limit preserves valid replies and bounds repair prompts" timeout="60s">
  <Each in={[
    {limit:0,request:"inspect",corrections:0,accepted:true},
    {limit:0,request:"oversized-summary",corrections:0,accepted:false},
    {limit:1,request:"oversized-summary",corrections:1,accepted:true},
    {limit:null,request:"oversized-summary",corrections:1,accepted:true},
    {limit:1,request:"uncorrectable-summary",corrections:1,accepted:false},
    {limit:null,request:"uncorrectable-summary",corrections:3,accepted:false}
  ]} let="scenario">
    <TempDir>
      <Fixture.Repository as="fixture" />
      <Dir path={fixture.repository}>
```bash exec as="observed"
git rev-parse HEAD
```
      </Dir>
      <Let as="attempt" value={fixture.root + "/limited-review"} />
      <Let as="assignment" value={{phase:"review",work:"test",repository:fixture.repository,revision:observed.stdout.trim(),priorRevision:null,request:scenario.request,changedPaths:[],artifacts:[],evidence:[],findings:[],assessment,continuation:{phase:"ready",role:null}}} />
      <Fixture.Entry entry="phase" value={{role:"planner",session:"original-planner",assignment,attempt,...(scenario.limit === null ? {} : {maxResponseCorrections:scenario.limit})}} command={runner} root={root} as="child" />
      <AssertEquals actual={child.exitCode === 0} expected={scenario.accepted} />
      <Dir path={attempt}>
        <Glob include={["response-corrections/**/called.json"]} as="repairs" />
        <Glob include={["result.json","response-acceptance.json"]} as="acceptedFiles" />
      </Dir>
      <AssertEquals actual={repairs.length} expected={scenario.corrections} />
      <AssertEquals actual={acceptedFiles.length} expected={scenario.accepted ? 2 : 0} />
      <Ticket.Text path={attempt + "/called.json"} as="calledText" />
      <Parse schema={{type:"object"}} as="called">{calledText}</Parse>
      <AssertEquals actual={called.session} expected="original-planner" />
      <Ticket.Text path={attempt + "/raw.txt"} as="raw" />
      <If condition={scenario.request !== "inspect"}>
        <AssertStringIncludes actual={raw} expected={"x".repeat(1201)} />
      </If>
      <If condition={scenario.corrections > 0}>
        <Ticket.Text path={attempt + "/response-corrections/0001/called.json"} as="repairText" />
        <Parse schema={{type:"object"}} as="repair">{repairText}</Parse>
        <AssertEquals actual={repair.session} expected="original-planner" />
        <AssertEquals actual={repair.initialize} expected={false} />
        <AssertEquals actual={repair.remaining} expected={(scenario.limit ?? 3) - 1} />
      </If>
      <If condition={scenario.accepted}>
        <Parse schema={{type:"object"}} as="result">{child.stdout}</Parse>
        <AssertEquals actual={result.revision} expected={assignment.revision} />
      <Else>
        <Ticket.Text path={attempt + "/response-rejection-0000.json"} as="rejection" />
        <Parse schema={{type:"object"}} as="rejected">{rejection}</Parse>
        <AssertEquals actual={rejected.code} expected="schema" />
        <Ticket.Text path={attempt + "/response-disposition.json"} as="dispositionText" />
        <Parse schema={{type:"object"}} as="disposition">{dispositionText}</Parse>
        <AssertEquals actual={disposition.code} expected={scenario.limit === 0 ? "response_correction_disabled" : "response_correction_exhausted"} />
        <AssertEquals actual={disposition.consumed} expected={scenario.corrections} />
        <AssertEquals actual={disposition.limit} expected={scenario.limit ?? 3} />
        <AssertEquals actual={disposition.dispatchable} expected={false} />
      </Else>
      </If>
    </TempDir>
  </Each>
</Test>

<Test name="invalid response limits refuse before reserving an attempt or calling a role" timeout="60s">
  <TempDir>
    <Fixture.Repository as="fixture" />
    <Each in={[-1,0.5,4,"0"]} let="limit">
      <Let as="attempt" value={fixture.root + "/never-started"} />
      <Fixture.Entry entry="phase" value={{role:"planner",session:"never-called",assignment:{},attempt,maxResponseCorrections:limit}} command={runner} root={root} as="child" />
      <AssertEquals actual={child.exitCode === 0} expected={false} />
      <Ticket.Capture as="refused">
        <Phase.Run phase="review" role="planner" session="never-called"
          assignment={{}} attempt={attempt} maxResponseCorrections={limit}
          successor="ready" as="unexpected" />
      </Ticket.Capture>
      <AssertEquals actual={refused.status} expected="failed" />
      <AssertStringIncludes actual={refused.failure} expected="maxResponseCorrections" />
      <Dir path={fixture.root}><Glob include={["never-started/**"]} as="effects" /></Dir>
      <AssertEquals actual={effects} expected={[]} />
    </Each>
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

<Test name="prototype spellings reach revision schema rejection without crashing" timeout="60s">
<TempDir>
<Fixture.Repository as="fixture" />
<Dir path={fixture.repository}>
```bash exec as="observed"
git rev-parse HEAD
```
</Dir>
<Let as="revision" value={observed.stdout.trim()} />
<Let as="assignment" value={{phase:"review",work:"test",repository:fixture.repository,revision,priorRevision:null,request:"Inspect the saved evidence.",changedPaths:[],artifacts:[],evidence:[],findings:[],assessment,continuation:{phase:"ready",role:null}}} />
<Each in={["constructor","toString","__proto__"]} let="invalid">
<Each in={["source","evidence"]} let="field">
<Let as="reply" value={{schema:"phase-result.v2",phase:"review",work:"test",outcome:"pass",revision:field === "source" ? invalid : revision,summary:"The saved checks passed.",handoff:"Inspect the saved evidence.",artifacts:[],evidence:[{revision:field === "evidence" ? invalid : revision,command:"saved focused test",outcome:"passed",artifact:"receipt.json"}],findings:[],next:{phase:"ready",role:null},assessment}} />
<Json value={reply} as="raw" />
<Phase.Response assignment={assignment} role="planner" text={raw} profile={{kind:"phase",knownDocuments:[]}} as="checked" />
<AssertEquals actual={checked.ok} expected={false} />
<AssertEquals actual={checked.rejection.code} expected="schema" />
</Each>
</Each>
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

<Test name="G10 continuation advances only the recorded next role and preserves correction standing" timeout="90s">
<Each in={[0,1]} let="limit">
<TempDir>
<Fixture.Repository as="fixture" />
<Dir path={fixture.repository}>
<File path="api.sh">format() { printf '%s' "$1"; }
</File>
```bash exec as="base"
git add api.sh
git commit -qm 'existing API'
git rev-parse HEAD
```
<If condition={base.exitCode !== 0}><Fail message={base.stderr} /></If>
</Dir>
<Let as="reference" value={fixture.root + "/accepted.md"} />
<Dir path={fixture.root}><File path="accepted.md">Captured original accepted behavior.</File></Dir>
<Let as="impact" value={{...assessment,evidence:[reference]}} />
<Let as="manifest" value={{schema:"ticket-workflow.v2",work:"test",directory:fixture.directory,maxCorrections:3,maxApiRepairs:2,maxResponseCorrections:limit,roles:{architect:{session:"conditional-architect",provider:"codex",initialized:true},planner:{session:"original-planner",provider:"codex",initialized:true},implementor:{session:"original-implementor",provider:"claude",initialized:true}},acceptedInputs:[{path:reference,content:"Captured original accepted behavior."}],deliveredInputs:{"original-planner":[reference],"original-implementor":[reference]},assignment:{phase:"implementation",work:"test",repository:fixture.repository,revision:base.stdout.trim(),priorRevision:null,request:"migrate-consumer",assessment:impact,changedPaths:[],artifacts:[],evidence:[],findings:[]}}} />
<Ticket.Start manifest={manifest} as="checkpoint" />
<Let as="record" value={{manifest,checkpoint:{...checkpoint,round:2},calls:[],documents:{[reference]:manifest.acceptedInputs[0]}}} />
<Dir path={fixture.directory + "/attempts"}><Let as="attemptsPrepared" value={true} /></Dir>
<Dir path={fixture.directory + "/calls"}><Let as="callsPrepared" value={true} /></Dir>
<Let as="pending" value={{...record,deliveredInputs:manifest.deliveredInputs,calls:[{id:"0000",role:"implementor",session:"original-implementor",provider:"claude",initialize:false,status:"accepted",result:"retained-result.json"}],checkpoint:{...record.checkpoint,gate:"planner-review",assignment:{...manifest.assignment,phase:"review",request:"oversized-summary"}}}} />
<AssertEquals actual={pending.checkpoint.dispatchable} expected={true} />
<AssertEquals actual={pending.checkpoint.gate} expected="planner-review" />
<AssertEquals actual={pending.checkpoint.round} expected={2} />
<Dir path={fixture.root}><File path="accepted.md">Changed mutable original after the recorded delivery.</File></Dir>
<Fixture.Entry entry="continue" value={pending} repository={fixture.repository} steps={1} command={runner} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="continued">{child.stdout}</Parse>
<If condition={continued.status !== (limit === 0 ? "hold" : "feedback_ready")}><Fail message={JSON.stringify(continued)} /></If>
<AssertEquals actual={continued.status} expected={limit === 0 ? "hold" : "feedback_ready"} />
<AssertEquals actual={continued.calls.slice(0,pending.calls.length)} expected={pending.calls} />
<AssertEquals actual={continued.calls.length} expected={pending.calls.length + 1} />
<AssertEquals actual={continued.calls.at(-1).role} expected="planner" />
<AssertEquals actual={continued.calls.at(-1).session} expected="original-planner" />
<AssertEquals actual={continued.calls.at(-1).provider} expected="codex" />
<AssertEquals actual={continued.calls.at(-1).initialize} expected={false} />
<AssertEquals actual={continued.calls.at(-1).inputs} expected={[]} />
<AssertEquals actual={continued.deliveredInputs} expected={pending.deliveredInputs} />
<AssertEquals actual={continued.manifest} expected={pending.manifest} />
<AssertEquals actual={continued.checkpoint.initialized} expected={pending.checkpoint.initialized} />
<AssertEquals actual={continued.checkpoint.round} expected={2} />
<Let as="attempt" value={fixture.directory + "/attempts/0001"} />
<Dir path={attempt}><Glob include={["response-corrections/**/called.json"]} as="repairs" /></Dir>
<AssertEquals actual={repairs.length} expected={limit} />
<If condition={limit === 0}>
<Ticket.Text path={attempt + "/response-disposition.json"} as="text" />
<Parse schema={{type:"object"}} as="disposition">{text}</Parse>
<AssertEquals actual={disposition.consumed} expected={0} />
<AssertEquals actual={disposition.limit} expected={0} />
<Else>
<Ticket.Text path={attempt + "/response-corrections/0001/called.json"} as="text" />
<Parse schema={{type:"object"}} as="repair">{text}</Parse>
<AssertEquals actual={repair.plannerProvider} expected="codex" />
<AssertEquals actual={repair.remaining} expected={0} />
</Else>
</If>
<Each in={Object.keys(pending.documents)} let="path"><AssertEquals actual={continued.documents[path]} expected={pending.documents[path]} /></Each>
<Dir path={fixture.root}><Glob include={["**/called.json"]} as="callsBefore" /></Dir>
<Fixture.Entry entry="continue" value={continued} repository={fixture.repository} steps={1} command={runner} root={root} as="again" />
<If condition={again.exitCode !== 0}><Fail message={again.stderr || again.stdout} /></If>
<Parse schema={{type:"object"}} as="completed">{again.stdout}</Parse>
<AssertEquals actual={completed} expected={continued} />
<Dir path={fixture.root}><Glob include={["**/called.json"]} as="callsAfter" /></Dir>
<AssertEquals actual={callsAfter} expected={callsBefore} />
</TempDir>
</Each>
</Test>

<Test name="normal launch forwards explicit zero and nonzero response budgets" timeout="90s">
<Each in={[{limit:0,ready:true},{limit:0,ready:false},{limit:1,ready:true},{limit:1,ready:false}]} let="scenario">
<Let as="limit" value={scenario.limit} />
<Let as="ready" value={scenario.ready} />
<TempDir>
<Fixture.Repository guides={true} as="fixture" />
<Dir path={fixture.repository}>
<File path="api.sh">format() { printf '%s' "$1"; }
</File>
```bash exec as="base"
git add api.sh
git commit -qm 'existing API'
git rev-parse HEAD
```
</Dir>
<Let as="evidence" value={fixture.root + "/accepted.md"} />
<Dir path={fixture.root}><File path="accepted.md">Accepted behavior and focused checks.</File></Dir>
<Let as="assessment" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"Inspect the accepted behavior.",evidence:[evidence]}} />
<Let as="directory" value={fixture.directory + (ready ? "-direct" : "-planned")} />
<Let as="task" value={{work:"test",repository:fixture.repository,directory,revision:base.stdout.trim(),request:"oversized-summary",inputs:[evidence],sessions:{planner:"original-planner",implementor:"original-implementor",architect:"conditional-architect"},providers:{architect:"codex",planner:"codex",implementor:"codex"},maxCorrections:0,maxApiRepairs:0,maxResponseCorrections:limit,assessment,scope:{decisions:{evidence:[evidence],openQuestions:[]},implementation:{ready,evidence:[evidence]},sharedApi:{needed:false,evidence:[evidence]},migration:null},delivery:{repository:"taras/executable.md",reviewer:{provider:"claude",model:"fixture",effort:null,session:"independent-review"},acceptance:[{id:"behavior",source:evidence,requirement:"Keep accepted behavior."}]}}} />
<Fixture.Entry entry="run" value={task} command={runner} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="work">{child.stdout}</Parse>
<AssertEquals actual={work.status} expected={limit === 0 ? "hold" : "feedback_ready"} />
<If condition={limit === 0 && !(work.reason ?? work.checkpoint?.hold?.reason)?.includes("response_correction_disabled")}><Fail message={work.reason ?? work.checkpoint?.hold?.reason ?? JSON.stringify(work)} /></If>
<Let as="attempt" value={directory + (ready ? "/attempts/0000" : "/planning")} />
<Dir path={attempt}><Glob include={["response-corrections/**/called.json"]} as="repairs" /></Dir>
<AssertEquals actual={repairs.length} expected={limit} />
<If condition={limit === 0}>
<Ticket.Text path={attempt + "/response-disposition.json"} as="text" />
<Parse schema={{type:"object"}} as="disposition">{text}</Parse>
<AssertEquals actual={disposition.consumed} expected={0} />
<AssertEquals actual={disposition.limit} expected={0} />
<Else>
<AssertEquals actual={work.manifest.maxResponseCorrections} expected={1} />
<AssertEquals actual={work.calls.every(call => call.provider === "codex")} expected={true} />
</Else>
</If>
</TempDir>
</Each>
</Test>
