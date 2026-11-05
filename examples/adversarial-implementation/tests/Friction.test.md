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
<Ticket.Read path={result.result} as="canonicalText" /><Parse schema={{type:"object"}} as="canonical">{canonicalText}</Parse>
<AssertEquals actual={canonical.evidence[0].revision} expected={checkout.head} />
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
<Let as="held" value={{schema:"ticket-return.v1",work:"test",source:null,status:"hold",revision:null,publication:"held",continuation:null,pending:null,hold:"Inspect the saved attempts."}} />
<Fixture.Entry entry="continue" value={held} command={runner} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="continued">{child.stdout}</Parse>
<AssertEquals actual={continued.publication} expected="held" /><AssertEquals actual={continued.continuation} expected={held.continuation} />
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
<Ticket.Snapshot repository={fixture.repository} directory={manifest.directory} path={reference} content={manifest.acceptedInputs[0].content} as="snapshot" />
<Let as="manifest" value={{...manifest,acceptedInputs:[snapshot]}} />
<Let as="record" value={{schema:"ticket-state.v1",manifest,checkpoint:{...checkpoint,round:2},calls:[],documents:{[reference]:snapshot},deliveredInputs:manifest.deliveredInputs}} />
<Ticket.Gate record={record} as="original" />
<Dir path={fixture.directory + "/attempts"}><Let as="attemptsPrepared" value={true} /></Dir>
<Dir path={fixture.directory + "/calls"}><Let as="callsPrepared" value={true} /></Dir>
<Let as="pending" value={{...record,deliveredInputs:manifest.deliveredInputs,calls:[{...original.call,inputs:[],status:"accepted",result:original.call.attempt + "/result.json",execution:original.call.record + "/execution.json"}],checkpoint:{...record.checkpoint,gate:"planner-review",assignment:{...manifest.assignment,phase:"review",request:"oversized-summary"}}}} />
<Ticket.Publish record={pending} as="pendingReturn" />
<AssertEquals actual={pending.checkpoint.dispatchable} expected={true} />
<AssertEquals actual={pending.checkpoint.gate} expected="planner-review" />
<AssertEquals actual={pending.checkpoint.round} expected={2} />
<Dir path={fixture.root}><File path="accepted.md">Changed mutable original after the recorded delivery.</File></Dir>
<Fixture.Entry entry="continue" value={pendingReturn} repository={fixture.repository} steps={1} command={runner} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="continued">{child.stdout}</Parse>
<Let as="continuedReturn" value={continued} /><Ticket.Load record={continuedReturn} as="continued" />
<If condition={continued.checkpoint.status !== (limit === 0 ? "hold" : "feedback_ready")}><Fail message={JSON.stringify(continued)} /></If>
<AssertEquals actual={continued.checkpoint.status} expected={limit === 0 ? "hold" : "feedback_ready"} />
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
<Fixture.Entry entry="continue" value={continuedReturn} repository={fixture.repository} steps={1} command={runner} root={root} as="again" />
<If condition={again.exitCode !== 0}><Fail message={again.stderr || again.stdout} /></If>
<Parse schema={{type:"object"}} as="completed">{again.stdout}</Parse>
<AssertEquals actual={completed} expected={continuedReturn} />
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
<Let as="workReturn" value={work} /><Ticket.Load record={workReturn} as="work" />
<AssertEquals actual={work.status} expected={limit === 0 ? "hold" : "feedback_ready"} />
<If condition={limit === 0 && !String(work.checkpoint.hold?.reason ?? "").includes("response_correction_disabled")}><Fail message={JSON.stringify(work.checkpoint.hold)} /></If>
<Let as="attempt" value={directory + "/attempts/0000"} />
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

<Test name="A3 initial planning boundaries continue original owners and pause repeated discovery" timeout="90s">
<TempDir>
<Fixture.Repository as="fixture" />
<Dir path={fixture.repository}>
```bash exec as="base"
git rev-parse HEAD
```
</Dir>
<Let as="reference" value={fixture.root + "/accepted.md"} />
<Dir path={fixture.root}><File path="accepted.md">Accepted immutable scope.</File></Dir>
<Let as="impact" value={{...assessment,architecture:true,evidence:[reference]}} />
<Let as="manifest" value={{schema:"ticket-workflow.v2",work:"test",directory:fixture.directory,maxCorrections:3,maxApiRepairs:3,maxResponseCorrections:0,roles:{architect:{session:"original-architect",provider:"codex",initialized:false},planner:{session:"original-planner",provider:"codex",initialized:false},implementor:{session:"original-implementor",provider:"codex",initialized:false}},acceptedInputs:[{path:reference,content:"Accepted immutable scope."}],assignment:{phase:"discovery",work:"test",repository:fixture.repository,revision:base.stdout.trim(),priorRevision:null,request:"#1084:again",assessment:impact,changedPaths:[],artifacts:[],evidence:[],findings:[],recipient:"planner",continuation:{phase:"implementation",role:"implementor"}}}} />
<Fixture.Entry entry="planning-case" value={manifest} repository={fixture.repository} command={runner} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="planner">{child.stdout}</Parse>
<Let as="plannerReturn" value={planner} /><Ticket.Load record={plannerReturn} as="planner" />
<If condition={!planner.checkpoint.dispatchable}><Fail message={JSON.stringify(planner)} /></If>
<AssertEquals actual={planner.checkpoint.gate} expected="architect-discovery" />
<AssertEquals actual={planner.checkpoint.reviews} expected={{}} />
<AssertEquals actual={planner.checkpoint.feedback} expected={[]} />
<Dir path={fixture.root}><File path="accepted.md">Mutable original changed after delivery.</File></Dir>
<Fixture.Entry entry="continue" value={plannerReturn} repository={fixture.repository} steps={1} command={runner} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="architect">{child.stdout}</Parse>
<Let as="architectReturn" value={architect} /><Ticket.Load record={architectReturn} as="architect" />
<Ticket.Read path={architect.calls[1].result} as="resultText" /><Parse schema={{type:"object"}} as="architectResult1">{resultText}</Parse>
<If condition={!architect.checkpoint.dispatchable}><Fail message={JSON.stringify(architect)} /></If>
<AssertEquals actual={architect.calls.slice(0,1)} expected={planner.calls} />
<AssertEquals actual={architect.checkpoint.gate} expected="planning" />
<AssertEquals actual={architect.calls[1].session} expected="original-architect" />
<AssertEquals actual={architect.calls[1].initialize} expected={true} />
<Ticket.Hydrate repository={fixture.repository} document={architect.documents[reference]} as="acceptedText" /><AssertEquals actual={acceptedText.content} expected="Accepted immutable scope." />
<Fixture.Entry entry="continue" value={architectReturn} repository={fixture.repository} steps={1} command={runner} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="returned">{child.stdout}</Parse>
<Let as="returnedReturn" value={returned} /><Ticket.Load record={returnedReturn} as="returned" />
<Ticket.Read path={returned.calls[2].result} as="resultText" /><Parse schema={{type:"object"}} as="returnedResult2">{resultText}</Parse>
<If condition={!returned.checkpoint.dispatchable}><Fail message={JSON.stringify(returned)} /></If>
<AssertEquals actual={returned.calls.slice(0,2)} expected={architect.calls} />
<AssertEquals actual={returned.calls[2].session} expected="original-planner" />
<AssertEquals actual={returned.calls[2].initialize} expected={false} />
<AssertEquals actual={returned.calls[2].inputs.map(input => input.path)} expected={architectResult1.handoffInputs.filter(path => !architect.deliveredInputs["original-planner"].includes(path))} />
<AssertEquals actual={returned.checkpoint.assignment.contract} expected={architectResult1.contract} />
<AssertEquals actual={returned.checkpoint.status} expected="paused" />
<AssertEquals actual={returned.checkpoint.hold} expected={null} />
<AssertEquals actual={returned.checkpoint.gate} expected="architect-discovery" />
<AssertEquals actual={returnedReturn.nextAction.entry} expected="continue.md" />
<Ticket.Continue record={returnedReturn} as="automatic" /><Ticket.Load record={automatic} as="automaticState" />
<AssertEquals actual={automaticState.calls} expected={returned.calls} />
<Fixture.Entry entry="continue" value={automatic} repository={fixture.repository} steps={1} command={runner} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="continued">{child.stdout}</Parse>
<Let as="continuedReturn" value={continued} /><Ticket.Load record={continuedReturn} as="continued" />
<AssertEquals actual={continued.calls.slice(0,3)} expected={returned.calls} />
<AssertEquals actual={continued.calls.length} expected={4} />
<AssertEquals actual={continued.calls[3].session} expected="original-architect" />
<AssertEquals actual={continued.calls[3].initialize} expected={false} />
<AssertEquals actual={continued.calls[3].inputs.map(input => input.path)} expected={returnedResult2.handoffInputs.filter(path => !returned.deliveredInputs["original-architect"].includes(path))} />
<AssertEquals actual={continued.manifest} expected={{...manifest,acceptedInputs:planner.manifest.acceptedInputs}} />
<AssertEquals actual={continued.checkpoint.round} expected={2} />
<AssertEquals actual={continued.checkpoint.reviews} expected={{}} />
<AssertEquals actual={continued.checkpoint.feedback} expected={[]} />
<AssertEquals actual={continued.deliveredInputs["original-planner"]} expected={returned.deliveredInputs["original-planner"]} />
<Each in={continued.calls} let="call"><Ticket.Read path={call.source} as="sourceText" /><Parse schema={{type:"object"}} as="sourceCapture">{sourceText}</Parse><Parse schema={{type:"object"}} as="source">{sourceCapture.output}</Parse><AssertEquals actual={{head:source.head,clean:source.clean}} expected={{head:manifest.assignment.revision,clean:true}} /></Each>
</TempDir>
</Test>

<Test name="accepted plan survives distinct implementation handoffs and retained correction" timeout="90s">
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
<Dir path={fixture.root}><File path="accepted.md">Accepted plan retention contract.</File></Dir>
<Let as="impact" value={{...assessment,architecture:true,evidence:[reference]}} />
<Let as="manifest" value={{schema:"ticket-workflow.v2",work:"handoff",directory:fixture.directory,maxCorrections:3,maxApiRepairs:3,maxResponseCorrections:0,roles:{architect:{session:"original-architect",provider:"codex",initialized:false},planner:{session:"original-planner",provider:"codex",initialized:false},implementor:{session:"original-implementor",provider:"codex",initialized:false}},acceptedInputs:[{path:reference,content:"Accepted plan retention contract."}],assignment:{phase:"discovery",work:"handoff",repository:fixture.repository,revision:base.stdout.trim(),priorRevision:null,request:"handoff-retention",assessment:impact,changedPaths:[],artifacts:[],evidence:[],findings:[],recipient:"planner",continuation:{phase:"implementation",role:"implementor"}}}} />
<Fixture.Entry entry="planning-case" value={manifest} repository={fixture.repository} command={runner} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="planned">{child.stdout}</Parse>
<Let as="plannedReturn" value={planned} /><Ticket.Load record={plannedReturn} as="planned" />
<Ticket.Read path={planned.calls[0].result} as="resultText" /><Parse schema={{type:"object"}} as="plannedResult0">{resultText}</Parse>
<AssertEquals actual={planned.calls[0].status} expected="accepted" />
<Let as="planPath" value={plannedResult0.handoffInputs[0]} />
<Ticket.Hydrate repository={fixture.repository} document={planned.documents[planPath]} as="plan" />
<AssertEquals actual={plan.content} expected="Use the existing format API for the remaining consumer. Remove legacy.fixture, run bash consumer.sh, and return its signed feedback commit." />
<Fixture.Entry entry="continue" value={plannedReturn} repository={fixture.repository} steps={3} command={runner} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="correcting">{child.stdout}</Parse>
<Let as="correctingReturn" value={correcting} /><Ticket.Load record={correctingReturn} as="correcting" />
<Ticket.Read path={correcting.calls[1].result} as="resultText" /><Parse schema={{type:"object"}} as="correctingResult1">{resultText}</Parse><Ticket.Read path={correcting.calls[3].result} as="resultText" /><Parse schema={{type:"object"}} as="correctingResult3">{resultText}</Parse>
<AssertEquals actual={correcting.calls.slice(0,1)} expected={planned.calls} />
<If condition={correcting.calls.length !== 4 || correcting.calls.some(call => call.result === undefined)}><Fail message={JSON.stringify(correcting)} /></If>
<Each in={correcting.calls} let="call"><Ticket.Read path={call.result} as="resultText" /><Parse schema={{type:"object"}} as="result">{resultText}</Parse><AssertEquals actual={[call.role,result.outcome]} expected={[["planner","complete"],["implementor","complete"],["architect","pass"],["planner","changes_required"]][Number(call.id)]} /></Each>
<Let as="implementationPath" value={correctingResult1.handoffInputs[0]} />
<Ticket.Hydrate repository={fixture.repository} document={correcting.documents[implementationPath]} as="implementation" />
<AssertEquals actual={implementation.content} expected="Initial implementation evidence: bash consumer.sh passed." />
<AssertEquals actual={correctingResult1.handoffInputs} expected={[implementationPath]} />
<AssertEquals actual={implementationPath === planPath} expected={false} />
<Each in={correcting.calls.slice(2)} let="review">
<Ticket.Text path={review.attempt + "/called.json"} as="text" />
<Parse schema={{type:"object"}} as="invoked">{text}</Parse>
<AssertEquals actual={invoked.inputs.map(input => input.path)} expected={review.inputs.map(input => input.path)} />
<AssertEquals actual={invoked.inputs.filter(input => input.path === planPath)} expected={[plan]} />
<AssertEquals actual={invoked.inputs.filter(input => input.path === implementationPath)} expected={[implementation]} />
</Each>
<AssertEquals actual={{status:correcting.checkpoint.status,gate:correcting.checkpoint.gate,round:correcting.checkpoint.round,dispatchable:correcting.checkpoint.dispatchable,hold:correcting.checkpoint.hold}} expected={{status:"paused",gate:"implementation",round:3,dispatchable:true,hold:null}} />
<Let as="correctionPath" value={correctingResult3.handoffInputs[0]} />
<AssertEquals actual={correcting.checkpoint.assignment.handoffInputs} expected={[correctionPath]} />
<Let as="quotedPlan" value={"'" + planPath.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="mutated"
printf '%s' 'Mutable plan file changed after capture.' > {quotedPlan}
```
<If condition={mutated.exitCode !== 0}><Fail message={mutated.stderr} /></If>
<Fixture.Entry entry="continue" value={correctingReturn} repository={fixture.repository} steps={1} command={runner} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="corrected">{child.stdout}</Parse>
<Let as="correctedReturn" value={corrected} /><Ticket.Load record={correctedReturn} as="corrected" />
<Ticket.Read path={corrected.calls[4].result} as="resultText" /><Parse schema={{type:"object"}} as="correctedResult4">{resultText}</Parse>
<AssertEquals actual={corrected.calls.slice(0,4)} expected={correcting.calls} />
<Let as="correctedPath" value={correctedResult4.handoffInputs[0]} />
<AssertEquals actual={correctedResult4.handoffInputs} expected={[correctedPath,correctionPath]} />
<Ticket.Hydrate repository={fixture.repository} document={corrected.documents[correctedPath]} as="correctedText" /><AssertEquals actual={correctedText.content} expected="Corrected implementation evidence: bash consumer.sh passed." />
<AssertEquals actual={corrected.checkpoint.feedbackInputs} expected={[planPath,implementationPath,correctionPath,correctedPath]} />
<Fixture.Entry entry="continue" value={correctedReturn} repository={fixture.repository} steps={2} command={runner} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="finished">{child.stdout}</Parse>
<Let as="finishedReturn" value={finished} /><Ticket.Load record={finishedReturn} as="finished" />
<AssertEquals actual={finished.calls.slice(0,5)} expected={corrected.calls} />
<AssertEquals actual={finished.checkpoint.status} expected="feedback_ready" />
<AssertEquals actual={finished.checkpoint.round} expected={3} />
<AssertEquals actual={finished.manifest} expected={{...manifest,acceptedInputs:planned.manifest.acceptedInputs}} />
<AssertEquals actual={finished.calls.map(call => call.initialize)} expected={[true,true,true,false,false,false,false]} />
<AssertEquals actual={finished.calls.map(call => call.session)} expected={["original-planner","original-implementor","original-architect","original-planner","original-implementor","original-architect","original-planner"]} />
<AssertEquals actual={finished.checkpoint.reviews} expected={{architect:finished.checkpoint.revision,planner:finished.checkpoint.revision}} />
<AssertEquals actual={finished.documents[planPath]} expected={planned.documents[planPath]} />
<Each in={["architect","planner"]} let="role">
<Let as="received" value={finished.calls.filter(call => call.role === role).flatMap(call => call.inputs)} />
<AssertEquals actual={received.filter(input => input.path === planPath)} expected={[planned.documents[planPath]]} />
<AssertEquals actual={received.filter(input => input.path === implementationPath)} expected={[correcting.documents[implementationPath]]} />
<AssertEquals actual={received.filter(input => input.path === correctedPath)} expected={[finished.documents[correctedPath]]} />
</Each>
<Each in={finished.calls.slice(5)} let="review">
<Ticket.Text path={review.attempt + "/called.json"} as="text" />
<Parse schema={{type:"object"}} as="invoked">{text}</Parse>
<AssertEquals actual={invoked.inputs.map(input => input.path)} expected={review.inputs.map(input => input.path)} />
<AssertEquals actual={review.assignment.handoffInputs.includes(planPath)} expected={true} />
<AssertEquals actual={new Set(review.assignment.handoffInputs).size} expected={review.assignment.handoffInputs.length} />
<AssertEquals actual={invoked.inputs.filter(input => input.path === planPath)} expected={[]} />
</Each>
</TempDir>
</Test>
