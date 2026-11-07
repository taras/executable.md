```bash exec as="location"
pwd -P
```
<Let as="root" value={location.stdout.trim()} />
<Let as="clause" value={'Keep the accepted scope. If validation fails, hold; except the named read-only case. Unresolved: preserve finding U. Run `deno task test focused.test.ts`. Review identity: exact-sha-123.\n'} />

<Test name="R D H P: production preparation continues only the unstarted successor and bounds unsuccessful reduction" timeout="180s">
<Each in={["success","validation","overage","missing","uncertain","identity"]} let="variant">
<TempDir>
```bash exec as="repositoryPrepared"
set -eu
mkdir repository
git -C repository init -q
git -C repository config user.name Fixture
git -C repository config user.email fixture@example.invalid
git -C repository config commit.gpgsign false
pwd -P
```
<Let as="fixture" value={{root:repositoryPrepared.stdout.trim(),repository:repositoryPrepared.stdout.trim()+"/repository",directory:repositoryPrepared.stdout.trim()+"/work"}} />
<Dir path={fixture.repository}>
<File path="AGENTS.md">Follow the accepted fixture assignment.</File>
<File path=".agents/planner.md">Prepare the accepted fixture plan.</File>
<File path=".agents/architect.md">Preserve the accepted fixture architecture.</File>
<Let as="guideContent" value={"g".repeat(11148)} /><File path=".agents/implementor.md">{guideContent}</File>
```bash exec as="base"
git add AGENTS.md .agents
git commit -qm 'fixture instructions'
git rev-parse HEAD
```
</Dir>
<Let as="context" value={{case:variant,plan:fixture.root+"/plan.md",matrix:fixture.root+"/matrix.md",architecture:fixture.root+"/architecture.md"}} />
<Let as="sources" value={[{path:context.plan,length:10837},{path:context.matrix,length:9325},{path:context.architecture,length:13944}]} />
<Each in={sources} let="source"><Let as="sourceContent" value={clause+"n".repeat(source.length-clause.length)} /><Dir path={fixture.root}><File path={source.path.slice(source.path.lastIndexOf("/")+1)}>{sourceContent}</File></Dir></Each>
<Let as="accepted" value={[6022,4419,2281,15805,1943].map((length,index) => ({path:fixture.root+"/seed-"+index+".md",content:"s".repeat(length)}))} />
<Let as="guide" value={{path:fixture.repository+"/.agents/implementor.md",content:"g".repeat(11148)}} />
<Let as="impact" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"Preserve the accepted synthetic contract.",evidence:[context.plan]}} />
<Let as="manifest" value={{schema:"ticket-workflow.v2",work:"preparation",directory:fixture.directory,roles:{planner:{session:"preparation-planner",provider:"codex",initialized:false},architect:{session:"preparation-architect",provider:"codex",initialized:false},implementor:{session:"preparation-implementor",provider:"codex",initialized:false}},maxCorrections:3,maxApiRepairs:0,maxResponseCorrections:0,acceptedInputs:accepted,roleInputs:{implementor:[guide]},assignment:{phase:"discovery",work:"preparation",repository:fixture.repository,revision:base.stdout.trim(),priorRevision:null,request:JSON.stringify(context),assessment:impact,artifacts:[],evidence:[],findings:[],changedPaths:[],recipient:"planner",continuation:{phase:"implementation",role:"implementor"}}}} />
<File path="manifest.json"><Json value={manifest} /></File>
<Let as="journeyText">
<Dir path={fixture.repository}>
<Execution host="run" target={root+"/examples/adversarial-implementation/tests/preparation-journey.md"} props={{manifest:fixture.root+"/manifest.json",identity:variant === "identity"}}>
<TestAgent>
<TestAgent.Scenario agent="codex" session="preparation-planner" src="./agents/preparation-planner.md" models={{selected:"gpt-6.1-sol",options:[{id:"gpt-6.1-sol",efforts:{selected:"medium",options:["medium","high"]}}]}} />
<TestAgent.Scenario agent="codex" session="preparation-architect" src="./agents/preparation-architect.md" models={{selected:"gpt-6.1-sol",options:[{id:"gpt-6.1-sol",efforts:{selected:"medium",options:["medium","high"]}}]}} />
<TestAgent.Scenario agent="codex" session="preparation-implementor" src="./agents/preparation-implementor.md" models={{selected:"gpt-6.1-sol",options:[{id:"gpt-6.1-sol",efforts:{selected:"medium",options:["medium","high"]}}]}} />
</TestAgent>
<CollectOutput as="stdout" />
{stdout}
</Execution>
</Dir>
</Let>
<Parse schema={{type:"object"}} as="journey">{journeyText}</Parse>
<Let as="planned" value={journey.planned} />
<Let as="continued" value={journey.continued} />
<AssertEquals actual={journey.firstFailure} expected="failed" />
<AssertEquals actual={journey.originalsPreserved} expected={true} />
<AssertEquals actual={journey.budget} expected={{limit:64000,total:75724,mandatory:41618,remaining:22382,excess:11724,admitted:false}} />
<AssertEquals actual={JSON.stringify(continued.calls.slice(0,3)) === JSON.stringify(planned.calls)} expected={true} />
<AssertEquals actual={continued.round} expected={planned.round} />
<AssertEquals actual={continued.manifest.maxCorrections} expected={3} />
<Let as="receiptPath" value={fixture.directory+"/preparations/0003/receipt.json"} />
<Ticket.Text path={receiptPath} as="text" /><Parse schema={{type:"object"}} as="receipt">{text}</Parse>
<AssertEquals actual={receipt.before} expected={journey.firstHashes} />
<AssertEquals actual={receipt.originalFailure.excess} expected={11724} />
<AssertEquals actual={receipt.owner.profile} expected={{provider:"codex",model:"gpt-6.1-sol",effort:"medium"}} />
<AssertEquals actual={[...journey.removed].sort()} expected={sources.map(source => source.path).sort()} />
<AssertEquals actual={JSON.stringify(continued).includes("Keep the accepted scope.")} expected={false} />
<AssertEquals actual={Object.values(continued.documents).every(document => !("content" in document))} expected={true} />
<If condition={receipt.attempts.length !== (variant === "overage" || variant === "identity" ? 1 : 2)}>
<Ticket.Text path={fixture.directory+"/preparations/0003/reduce-execution.json"} as="failureText" /><Parse schema={{type:"object"}} as="failed">{failureText}</Parse>
<Fail message={JSON.stringify({reason:receipt.reason,execution:failed})} />
</If>
<AssertEquals actual={receipt.attempts.length} expected={variant === "overage" || variant === "identity" ? 1 : 2} />
<If condition={variant === "success" || variant === "validation"}>
<AssertEquals actual={continued.calls.length} expected={4} />
<AssertEquals actual={continued.calls[3].session} expected="preparation-implementor" />
<AssertEquals actual={continued.checkpoint.initialized.implementor} expected={true} />
<AssertEquals actual={continued.calls[3].status} expected={variant === "validation" ? "failed_without_result" : "accepted"} />
<Ticket.Text path={fixture.directory+"/preparations/0003/dispatch.json"} as="text" /><Parse schema={{type:"object"}} as="dispatch">{text}</Parse>
<AssertEquals actual={dispatch.result} expected={variant === "validation" ? null : fixture.directory+"/attempts/0003/result.json"} />
<If condition={variant === "success"}>
<Ticket.Text path={dispatch.result} as="text" /><Parse schema={{type:"object"}} as="result">{text}</Parse>
<AssertEquals actual={continued.calls[3].result} expected={dispatch.result} />
<AssertEquals actual={result.outcome} expected="needs_discovery" />
</If>
<AssertEquals actual={continued.calls[3].inputs.every(input => !("content" in input) && JSON.stringify(continued.documents[input.path]) === JSON.stringify(input))} expected={true} />
<Ticket.Selected repository={fixture.repository} documents={Object.fromEntries(continued.calls[3].inputs.map(input => [input.path,input]))} as="sentTexts" />
<Let as="sentInputs" value={continued.calls[3].inputs.map(input => sentTexts[input.path])} />
<AssertEquals actual={sentInputs.reduce((total,input) => total+input.content.length,0)<=64000} expected={true} />
<AssertEquals actual={receipt.status} expected="ready" />
<AssertEquals actual={receipt.revalidated.total} expected={sentInputs.reduce((total,input) => total+input.content.length,0)} />
<AssertEquals actual={continued.calls[3].preparation} expected={receiptPath} />
<AssertEquals actual={continued.calls[3].delivery} expected={fixture.directory+"/attempts/0003/delivery.json"} />
<Ticket.Text path={continued.calls[3].delivery} as="deliveryText" /><Parse schema={{type:"object"}} as="delivered">{deliveryText}</Parse>
<AssertEquals actual={delivered.inputs} expected={receipt.after} />
<AssertEquals actual={continued.calls[3].profile} expected={delivered.profile} />
<AssertEquals actual={receipt.attempts.every(attempt => attempt.material.every(window => window.characters <= 8000))} expected={true} />
<Ticket.Text path={receipt.mapping} as="mappingText" />
<AssertEquals actual={receipt.attempts.reduce((total,attempt) => total+attempt.acquired,0)} expected={68212+receipt.after.find(input => input.path === receipt.candidate).characters+mappingText.length} />
<Ticket.Hydrate repository={fixture.repository} document={continued.documents[receipt.candidate]} as="candidate" />
<AssertStringIncludes actual={candidate.content} expected={clause} />
<Ticket.Fingerprint inputs={sentInputs} as="sent" />
<AssertEquals actual={receipt.after} expected={sent} />
<AssertEquals actual={continued.deliveredInputs["preparation-implementor"]} expected={sentInputs.map(input => input.path)} />
<Else>
<AssertEquals actual={continued.calls.length} expected={3} />
<AssertEquals actual={receipt.status} expected="hold" />
<AssertEquals actual={continued.checkpoint.hold} expected={{kind:"input_preparation",reason:receipt.reason,receipt:receiptPath}} />
<If condition={variant === "overage"}>
<AssertStringIncludes actual={receipt.reason} expected="Reduced packet still exceeds" />
<AssertEquals actual={receipt.revalidated.admitted} expected={false} />
<Else>
<If condition={variant === "identity"}>
<AssertStringIncludes actual={receipt.reason} expected="Reduction failed" />
<Ticket.Text path={fixture.directory+"/preparations/0003/reduce-execution.json"} as="refusalText" /><Parse schema={{type:"object"}} as="refusal">{refusalText}</Parse>
<AssertStringIncludes actual={refusal.failure} expected="Workflow session identity changed" />
<AssertEquals actual={journey.identityPreserved} expected={true} />
<Ticket.Text path={journey.identityPath + ".mismatch.json"} as="mismatch" />
<AssertStringIncludes actual={mismatch} expected="substituted." />
<Else>
<AssertEquals actual={receipt.comparison.sufficient} expected={false} />
<AssertEquals actual={variant === "missing" ? receipt.comparison.missing.length : receipt.comparison.uncertain.length} expected={1} />
</Else>
</If>
</Else>
</If>
<AssertEquals actual={continued.checkpoint.initialized.implementor} expected={false} />
<Ticket.Continue record={journey.continuedReturn} maxSteps={1} as="heldReturn" />
<Ticket.Load record={heldReturn} as="held" />
<AssertEquals actual={JSON.stringify(held.calls) === JSON.stringify(continued.calls)} expected={true} />
<AssertEquals actual={JSON.stringify(held.checkpoint) === JSON.stringify(continued.checkpoint)} expected={true} />
</Else>
</If>
</TempDir>
</Each>
</Test>

<Test name="D C: pre-Prompt and uncertain failures preserve delivery; standalone uses the same admission" timeout="120s">
<Each in={["preprompt","uncertain","standalone-fit","standalone-overage"]} let="variant">
<TempDir>
```bash exec as="repositoryPrepared"
set -eu
mkdir repository
git -C repository init -q
git -C repository config user.name Fixture
git -C repository config user.email fixture@example.invalid
git -C repository config commit.gpgsign false
pwd -P
```
<Let as="fixture" value={{root:repositoryPrepared.stdout.trim(),repository:repositoryPrepared.stdout.trim()+"/repository",directory:repositoryPrepared.stdout.trim()+"/work"}} />
<Dir path={fixture.repository}>
<File path="AGENTS.md">Follow the selected fixture assignment.</File>
<File path=".agents/implementor.md">Preserve the selected input.</File>
```bash exec as="base"
git add AGENTS.md .agents
git commit -qm 'fixture base'
git rev-parse HEAD
```
</Dir>
<Let as="chosen" value={{path:fixture.root+"/chosen.md",content:variant === "standalone-overage" ? "x".repeat(65000) : "explicit document"}} />
<File path="chosen.md">{chosen.content}</File>
<Let as="impact" value={{mechanical:true,architecture:false,acceptance:false,risk:null,reason:"Exercise delivery receipts.",evidence:[chosen.path]}} />
<Let as="assignment" value={{phase:"implementation",work:"delivery",repository:fixture.repository,revision:base.stdout.trim(),priorRevision:null,request:variant === "preprompt" ? "x".repeat(256000) : "Inspect the selected evidence.",assessment:impact,changedPaths:[],artifacts:[],evidence:[],findings:[]}} />
<Let as="standalone" value={variant.startsWith("standalone")} />
<Let as="session" value={standalone ? "standalone-recipient" : "delivery-recipient"} />
<Let as="old" value={{path:fixture.root+"/old.md",content:"previously delivered"}} />
<Let as="manifest" value={{schema:"ticket-workflow.v2",work:"delivery",directory:fixture.directory,roles:{planner:{session:"planner",provider:"codex",initialized:false},architect:{session:"architect",provider:"codex",initialized:false},implementor:{session,provider:"codex",initialized:variant === "uncertain"}},maxCorrections:3,maxApiRepairs:0,maxResponseCorrections:0,acceptedInputs:[old,chosen],deliveredInputs:variant === "uncertain" ? {[session]:[old.path]} : {},assignment}} />
<Let as="request" value={{role:"architect",session,assignment:{...assignment,phase:"review",handoffInputs:[chosen.path],continuation:{phase:"ready",role:null}},attempt:fixture.root+"/standalone",initialize:false,inputPaths:[],maxResponseCorrections:0}} />
<File path="input.json"><Json value={standalone ? request : manifest} /></File>
<Let as="observed">
<Dir path={fixture.repository}>
<Execution host="run" target={root+"/examples/adversarial-implementation/"+(standalone ? "phase.md" : "tests/delivery-journey.md")} props={standalone ? {request:fixture.root+"/input.json"} : {manifest:fixture.root+"/input.json"}} as="child">
<TestAgent>
<TestAgent.Scenario agent="codex" session={session} src={standalone ? "./agents/preparation-invalid.md" : "./agents/preparation-uncertain.md"} models={{selected:"gpt-6.1-sol",options:[{id:"gpt-6.1-sol",efforts:{selected:"medium",options:["medium","high"]}}]}} />
</TestAgent>
<CollectOutput as="stdout" />
</Execution>
<Json value={{outcome:child,stdout}} />
</Dir>
</Let>
<Parse schema={{type:"object"}} as="observed">{observed}</Parse>
<If condition={standalone}>
<AssertEquals actual={observed.outcome.result.ok} expected={false} />
<Ticket.Text path={fixture.root+"/standalone-handoff/preparations/standalone/receipt.json"} as="text" /><Parse schema={{type:"object"}} as="receipt">{text}</Parse>
<AssertEquals actual={receipt.attempts} expected={[]} />
<AssertEquals actual={receipt.budget.total} expected={chosen.content.length} />
<AssertEquals actual={receipt.status} expected={variant === "standalone-fit" ? "ready" : "hold"} />
<If condition={variant === "standalone-fit"}>
<Ticket.Text path={fixture.root+"/standalone/delivery.json"} as="text" /><Parse schema={{type:"object"}} as="delivery">{text}</Parse>
<Ticket.Fingerprint inputs={[chosen]} as="expected" />
<AssertEquals actual={delivery.inputs} expected={expected} />
</If>
<Else>
<AssertEquals actual={observed.outcome.result.ok} expected={true} />
<Parse schema={{type:"object"}} as="journey">{observed.stdout}</Parse>
<AssertEquals actual={journey.first.calls.length} expected={1} />
<AssertEquals actual={JSON.stringify(journey.again.calls) === JSON.stringify(journey.first.calls)} expected={true} />
<AssertEquals actual={journey.first.deliveredInputs} expected={manifest.deliveredInputs} />
<AssertEquals actual={journey.first.checkpoint.initialized.implementor} expected={variant === "uncertain"} />
<AssertEquals actual={journey.first.calls[0].delivery} expected={null} />
<If condition={variant === "preprompt"}><AssertStringIncludes actual={journey.first.checkpoint.hold.reason} expected="complete phase prompt exceeds 256000" /></If>
</Else>
</If>
</TempDir>
</Each>
</Test>
