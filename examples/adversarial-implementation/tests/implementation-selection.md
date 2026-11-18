```bash exec as="location"
pwd -P
```
<Let as="root" value={location.stdout.trim()} />
```bash exec as="commandSetting"
printf '%s' "$XMD_EXAMPLE_COMMAND"
```
<Let as="runner" value={commandSetting.stdout || "deno run --allow-all --node-modules-dir=manual --cached-only --frozen '" + root.replaceAll("'","'\"'\"'") + "/packages/cli/src/deno.ts' run --allow-absolute"} />

<Test name="A1 A4 explicit Implementor model and ordinary step limit select Sonnet and resume the same record" timeout="120s">
<Each in={[
  {name:"explicit planned",ready:false,model:"sonnet",steps:1},
  {name:"explicit ready",ready:true,model:"sonnet",steps:1},
  {name:"default planned",ready:false,model:undefined,steps:undefined}
]} let="scenario">
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
<If condition={base.exitCode !== 0}><Fail message={base.stderr} /></If>
</Dir>
<Dir path={fixture.root}><File path="accepted.md">Evidence A: accepted format behavior and focused consumer checks.</File></Dir>
<Let as="evidence" value={fixture.root + "/accepted.md"} />
<Let as="assessment" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"Inspect the accepted consumer behavior.",evidence:[evidence]}} />
<Let as="task" value={{work:"test",repository:fixture.repository,directory:fixture.directory,revision:base.stdout.trim(),request:scenario.name,inputs:[evidence],sessions:{planner:"original-planner",implementor:"original-implementor",architect:"conditional-architect"},providers:{architect:"codex",planner:"claude",implementor:"claude"},...(scenario.model === undefined ? {} : {implementationModel:scenario.model}),maxResponseCorrections:0,maxCorrections:3,maxApiRepairs:3,assessment,scope:{decisions:{evidence:[evidence],openQuestions:[]},implementation:{ready:scenario.ready,evidence:[evidence]},sharedApi:{needed:false,evidence:[evidence]},migration:null}}} />
<Let as="task" value={{...task,delivery:{repository:"taras/executable.md",reviewer:{provider:"claude",model:"fixture",effort:null,session:"independent-review"},acceptance:[{id:"accepted-behavior",source:task.inputs[0],requirement:"Preserve the original accepted behavior."}]}}} />
<Fixture.Entry entry="run" value={task} maxSteps={scenario.steps} command={runner} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="work">{child.stdout}</Parse>
<Ticket.Load record={work} as="saved" />
<AssertEquals actual={saved.manifest.roles.implementor.model} expected={scenario.model} />
<AssertEquals actual={Object.hasOwn(saved.manifest.roles.implementor,"model")} expected={scenario.model !== undefined} />
<AssertEquals actual={Object.hasOwn(saved.manifest.roles.planner,"model")} expected={false} />
<If condition={scenario.steps === undefined}>
<AssertEquals actual={work.status} expected="feedback_ready" />
<Ticket.Text path={saved.calls.find(call => call.role === "implementor").attempt + "/called.json"} as="defaultText" />
<Parse schema={{type:"object"}} as="defaultCalled">{defaultText}</Parse>
<AssertEquals actual={Object.hasOwn(defaultCalled,"implementationModel")} expected={false} />
<AssertEquals actual={defaultCalled.implementationProvider} expected="claude" />
<Else>
<AssertEquals actual={work.status} expected="paused" />
<AssertEquals actual={saved.checkpoint.dispatchable} expected={true} />
<If condition={scenario.ready}>
<AssertEquals actual={saved.calls.map(call => call.role)} expected={["implementor"]} />
<Else>
<AssertEquals actual={saved.calls.map(call => call.role)} expected={["planner"]} />
<AssertEquals actual={saved.checkpoint.gate} expected="implementation" />
<Dir path={fixture.directory}><Glob include={["attempts/*/called.json"]} as="called" /></Dir>
<AssertEquals actual={called} expected={["attempts/0000/called.json"]} />
<Dir path={fixture.root}><File path="accepted.md">Evidence B: mutable original after the bounded start.</File></Dir>
<Fixture.Entry entry="continue" value={work} repository={fixture.repository} steps={1} command={runner} root={root} as="again" />
<If condition={again.exitCode !== 0}><Fail message={again.stderr || again.stdout} /></If>
<Parse schema={{type:"object"}} as="continued">{again.stdout}</Parse>
<Ticket.Load record={continued} as="resumed" />
<AssertEquals actual={resumed.calls.map(call => call.role)} expected={["planner","implementor"]} />
<AssertEquals actual={resumed.calls.slice(0,1)} expected={saved.calls} />
<AssertEquals actual={resumed.calls[1].initialize} expected={true} />
<AssertEquals actual={resumed.manifest} expected={saved.manifest} />
<Ticket.Text path={resumed.calls[1].attempt + "/called.json"} as="implementorText" />
<Parse schema={{type:"object"}} as="implementor">{implementorText}</Parse>
<AssertEquals actual={implementor.implementationModel} expected="sonnet" />
<AssertEquals actual={implementor.implementationProvider} expected="claude" />
<AssertEquals actual={implementor.inputs.find(input => input.path === evidence).content} expected="Evidence A: accepted format behavior and focused consumer checks." />
</Else>
</If>
<If condition={scenario.ready}>
<Ticket.Text path={saved.calls[0].attempt + "/called.json"} as="readyText" />
<Parse schema={{type:"object"}} as="readyCalled">{readyText}</Parse>
<AssertEquals actual={readyCalled.implementationModel} expected="sonnet" />
<AssertEquals actual={readyCalled.initialize} expected={true} />
</If>
</Else>
</If>
</TempDir>
</Each>
</Test>

<Test name="A5 a paused unused Claude Implementor adopts Sonnet and keeps its original record" timeout="150s">
<Each in={["component","entry"]} let="via">
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
<Let as="approval" value={fixture.root + "/sonnet-approval.md"} />
<Dir path={fixture.root}><File path="accepted.md">Accepted plan retention contract.</File><File path="sonnet-approval.md">The user selected Claude Sonnet for the unused Implementor.</File></Dir>
<Let as="impact" value={{mechanical:false,architecture:true,acceptance:true,risk:null,reason:"Inspect the saved test evidence.",evidence:[reference]}} />
<Let as="manifest" value={{schema:"ticket-workflow.v2",work:"handoff",directory:fixture.directory,maxCorrections:3,maxApiRepairs:3,maxResponseCorrections:0,roles:{architect:{session:"original-architect",provider:"codex",initialized:false},planner:{session:"original-planner",provider:"claude",initialized:false},implementor:{session:"original-implementor",provider:"claude",initialized:false}},acceptedInputs:[{path:reference,content:"Accepted plan retention contract."}],assignment:{phase:"discovery",work:"handoff",repository:fixture.repository,revision:base.stdout.trim(),priorRevision:null,request:"handoff-retention",assessment:impact,changedPaths:[],artifacts:[],evidence:[],findings:[],recipient:"planner",continuation:{phase:"implementation",role:"implementor"}}}} />
<Fixture.Entry entry="planning-case" value={manifest} repository={fixture.repository} command={runner} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="planned">{child.stdout}</Parse>
<Let as="plannedReturn" value={planned} /><Ticket.Load record={plannedReturn} as="planned" />
<AssertEquals actual={[planned.checkpoint.status,planned.checkpoint.gate,planned.checkpoint.dispatchable]} expected={["paused","implementation",true]} />
<AssertEquals actual={planned.calls.map(call => call.role)} expected={["planner"]} />
<AssertEquals actual={Object.hasOwn(planned.manifest.roles.implementor,"model")} expected={false} />
<Let as="quotedPrior" value={"'" + plannedReturn.continuation.path.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="priorBefore"
shasum -a 256 -- {quotedPrior}
```
<If condition={via === "component"}>
<Ticket.SelectModel record={plannedReturn} model="sonnet" evidence={approval} as="amendedReturn" />
<Else>
<Fixture.Entry entry="continue" value={plannedReturn} repository={fixture.repository} steps={1} extraProps={["--props-implementation-model","sonnet","--props-implementation-model-evidence",approval]} command={runner} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="amendedReturn">{child.stdout}</Parse>
</Else>
</If>
<AssertEquals actual={amendedReturn.publication} expected="confirmed" />
<AssertEquals actual={amendedReturn.continuation.path === plannedReturn.continuation.path} expected={false} />
```bash exec as="priorAfter"
shasum -a 256 -- {quotedPrior}
```
<AssertEquals actual={priorAfter.stdout} expected={priorBefore.stdout} />
<Dir path={fixture.root}><File path="sonnet-approval.md">Mutated after the selection was retained.</File></Dir>
<Ticket.Load record={amendedReturn} as="amended" />
<Ticket.Hydrate repository={fixture.repository} document={amended.documents[approval]} as="retainedApproval" />
<AssertEquals actual={retainedApproval.content} expected="The user selected Claude Sonnet for the unused Implementor." />
<AssertEquals actual={amended.manifest.roles.implementor} expected={{...planned.manifest.roles.implementor,model:"sonnet"}} />
<AssertEquals actual={amended.manifest.implementationModelSelection} expected={{previousContinuation:plannedReturn.continuation,previousModel:null,model:"sonnet",evidence:amended.documents[approval]}} />
<AssertEquals actual={amended.calls.slice(0,1)} expected={planned.calls} />
<AssertEquals actual={Object.fromEntries(Object.keys(planned.documents).map(path => [path,amended.documents[path]]))} expected={planned.documents} />
<AssertEquals actual={amended.manifest.roles.planner} expected={planned.manifest.roles.planner} />
<AssertEquals actual={amended.manifest.roles.architect} expected={planned.manifest.roles.architect} />
<AssertEquals actual={[amended.manifest.maxCorrections,amended.manifest.maxApiRepairs,amended.manifest.maxResponseCorrections,amended.manifest.assignment,amended.manifest.acceptedInputs]} expected={[planned.manifest.maxCorrections,planned.manifest.maxApiRepairs,planned.manifest.maxResponseCorrections,planned.manifest.assignment,planned.manifest.acceptedInputs]} />
<If condition={via === "component"}>
<AssertEquals actual={amended.checkpoint.initialized.implementor} expected={false} />
<AssertEquals actual={amended.checkpoint} expected={planned.checkpoint} />
<AssertEquals actual={amended.deliveredInputs} expected={planned.deliveredInputs} />
<AssertEquals actual={amended.calls} expected={planned.calls} />
<Dir path={fixture.directory}><Glob include={["attempts/*/called.json"]} as="beforeStep" /></Dir>
<AssertEquals actual={beforeStep} expected={["attempts/0000/called.json"]} />
<Fixture.Entry entry="continue" value={amendedReturn} repository={fixture.repository} steps={1} command={runner} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="amendedReturn">{child.stdout}</Parse>
<Ticket.Load record={amendedReturn} as="amended" />
</If>
<AssertEquals actual={amended.calls.map(call => call.role)} expected={["planner","implementor"]} />
<AssertEquals actual={amended.calls[1].initialize} expected={true} />
<Ticket.Text path={amended.calls[1].attempt + "/called.json"} as="implementorText" />
<Parse schema={{type:"object"}} as="implementor">{implementorText}</Parse>
<AssertEquals actual={[implementor.session,implementor.implementationProvider,implementor.implementationModel]} expected={["original-implementor","claude","sonnet"]} />
<AssertEquals actual={implementor.inputs.find(input => input.path === reference).content} expected="Accepted plan retention contract." />
<Fixture.Entry entry="continue" value={amendedReturn} repository={fixture.repository} steps={2} command={runner} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="reviewedReturn">{child.stdout}</Parse>
<Ticket.Load record={reviewedReturn} as="reviewed" />
<AssertEquals actual={reviewed.calls.map(call => call.role)} expected={["planner","implementor","architect","planner"]} />
<AssertEquals actual={reviewed.checkpoint.gate} expected="implementation" />
<Fixture.Entry entry="continue" value={reviewedReturn} repository={fixture.repository} steps={1} command={runner} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="correctedReturn">{child.stdout}</Parse>
<Ticket.Load record={correctedReturn} as="corrected" />
<AssertEquals actual={corrected.calls.map(call => call.role)} expected={["planner","implementor","architect","planner","implementor"]} />
<AssertEquals actual={corrected.calls[4].initialize} expected={false} />
<AssertEquals actual={corrected.calls[4].session} expected="original-implementor" />
<Ticket.Text path={corrected.calls[4].attempt + "/called.json"} as="correctionText" />
<Parse schema={{type:"object"}} as="correction">{correctionText}</Parse>
<AssertEquals actual={[correction.implementationProvider,correction.implementationModel]} expected={["claude","sonnet"]} />
<AssertEquals actual={corrected.manifest} expected={amended.manifest} />
</TempDir>
</Each>
</Test>

<Test name="A6 unsupported Implementor model changes refuse before any role or record change" timeout="240s">
<Each in={[
  {name:"model without authorization",model:true,evidence:false,message:"Select implementationModel and implementationModelEvidence together."},
  {name:"authorization without model",model:false,evidence:true,message:"Select implementationModel and implementationModelEvidence together."},
  {name:"occupied attempt",kind:"attempt",model:true,evidence:true,message:"confirmed paused implementation handoff before its first dispatch"},
  {name:"occupied call record",kind:"call",model:true,evidence:true,message:"confirmed paused implementation handoff before its first dispatch"},
  {name:"existing identity receipt",kind:"identity",model:true,evidence:true,message:"confirmed paused implementation handoff before its first dispatch"},
  {name:"initialized Implementor",kind:"initialized",model:true,evidence:true,message:"confirmed paused implementation handoff before its first dispatch"},
  {name:"other gate",kind:"gate",request:"#1084:again",model:true,evidence:true,message:"confirmed paused implementation handoff before its first dispatch"},
  {name:"held record",kind:"hold",request:"#1084:blocked",model:true,evidence:true,message:"confirmed paused implementation handoff before its first dispatch"},
  {name:"recorded reference",kind:"recorded",model:true,evidence:true,message:"give the authorization a fresh reference"},
  {name:"unreadable authorization",kind:"unreadable",model:true,evidence:true,message:"missing-approval.md"}
]} let="scenario">
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
<Let as="approval" value={scenario.kind === "recorded" ? reference : scenario.kind === "unreadable" ? fixture.root + "/missing-approval.md" : fixture.root + "/sonnet-approval.md"} />
<Dir path={fixture.root}><File path="accepted.md">Accepted plan retention contract.</File><File path="sonnet-approval.md">The user selected Claude Sonnet for the unused Implementor.</File></Dir>
<Let as="impact" value={{mechanical:false,architecture:true,acceptance:true,risk:null,reason:"Inspect the saved test evidence.",evidence:[reference]}} />
<Let as="manifest" value={{schema:"ticket-workflow.v2",work:"handoff",directory:fixture.directory,maxCorrections:3,maxApiRepairs:3,maxResponseCorrections:0,roles:{architect:{session:"original-architect",provider:"codex",initialized:false},planner:{session:"original-planner",provider:"claude",initialized:false},implementor:{session:"original-implementor",provider:"claude",initialized:scenario.kind === "initialized"}},acceptedInputs:[{path:reference,content:"Accepted plan retention contract."}],assignment:{phase:"discovery",work:"handoff",repository:fixture.repository,revision:base.stdout.trim(),priorRevision:null,request:scenario.request ?? "handoff-retention",assessment:impact,changedPaths:[],artifacts:[],evidence:[],findings:[],recipient:"planner",continuation:{phase:"implementation",role:"implementor"}}}} />
<Fixture.Entry entry="planning-case" value={manifest} repository={fixture.repository} command={runner} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="plannedReturn">{child.stdout}</Parse>
<Let as="quotedDirectory" value={"'" + fixture.directory.replaceAll("'","'\"'\"'") + "'"} />
<If condition={scenario.kind === "attempt"}>
```bash exec as="occupied"
mkdir -- {quotedDirectory}/attempts/0001
```
<If condition={occupied.exitCode !== 0}><Fail message={occupied.stderr} /></If>
</If>
<If condition={scenario.kind === "call"}>
```bash exec as="occupied"
mkdir -- {quotedDirectory}/calls/0001
```
<If condition={occupied.exitCode !== 0}><Fail message={occupied.stderr} /></If>
</If>
<If condition={scenario.kind === "identity"}>
<Dir path={fixture.directory + "/sessions"}><File path="original-implementor.json">{"{}"}</File></Dir>
</If>
<Dir path={fixture.directory}><Glob include={["**"]} as="before" /></Dir>
<Let as="quotedPrior" value={"'" + plannedReturn.continuation.path.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="priorBefore"
shasum -a 256 -- {quotedPrior}
```
<Fixture.Entry entry="continue" value={plannedReturn} repository={fixture.repository} steps={1} extraProps={[...(scenario.model ? ["--props-implementation-model","sonnet"] : []),...(scenario.evidence ? ["--props-implementation-model-evidence",approval] : [])]} command={runner} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="refused">{child.stdout}</Parse>
<AssertEquals actual={[refused.status,refused.publication]} expected={["hold","held"]} />
<AssertEquals actual={refused.continuation} expected={plannedReturn.continuation} />
<AssertEquals actual={refused.failure.name} expected="ContinuationRefused" />
<AssertStringIncludes actual={refused.failure.message} expected={scenario.message} />
<Dir path={fixture.directory}><Glob include={["**"]} as="after" /></Dir>
<AssertEquals actual={after} expected={before} />
```bash exec as="priorAfter"
shasum -a 256 -- {quotedPrior}
```
<AssertEquals actual={priorAfter.stdout} expected={priorBefore.stdout} />
<Dir path={fixture.directory}><Glob include={["**/called.json"]} as="called" /></Dir>
<AssertEquals actual={called} expected={["attempts/0000/called.json"]} />
</TempDir>
</Each>
</Test>

<Test name="A6 an unconfirmed model selection publication dispatches nobody and keeps the prior continuation" timeout="120s">
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
<Let as="approval" value={fixture.root + "/sonnet-approval.md"} />
<Dir path={fixture.root}><File path="accepted.md">Accepted plan retention contract.</File><File path="sonnet-approval.md">The user selected Claude Sonnet for the unused Implementor.</File></Dir>
<Let as="impact" value={{mechanical:false,architecture:true,acceptance:true,risk:null,reason:"Inspect the saved test evidence.",evidence:[reference]}} />
<Let as="manifest" value={{schema:"ticket-workflow.v2",work:"handoff",directory:fixture.directory,maxCorrections:3,maxApiRepairs:3,maxResponseCorrections:0,roles:{architect:{session:"original-architect",provider:"codex",initialized:false},planner:{session:"original-planner",provider:"claude",initialized:false},implementor:{session:"original-implementor",provider:"claude",initialized:false}},acceptedInputs:[{path:reference,content:"Accepted plan retention contract."}],assignment:{phase:"discovery",work:"handoff",repository:fixture.repository,revision:base.stdout.trim(),priorRevision:null,request:"handoff-retention",assessment:impact,changedPaths:[],artifacts:[],evidence:[],findings:[],recipient:"planner",continuation:{phase:"implementation",role:"implementor"}}}} />
<Fixture.Entry entry="planning-case" value={manifest} repository={fixture.repository} command={runner} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="plannedReturn">{child.stdout}</Parse>
<Dir path={fixture.directory}><Glob include={["continuations/*.json"]} as="before" /></Dir>
<Let as="continuations" value={"'" + (fixture.directory + "/continuations").replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="locked"
chmod 555 {continuations}
```
<If condition={locked.exitCode !== 0}><Fail message={locked.stderr} /></If>
<Fixture.Entry entry="continue" value={plannedReturn} repository={fixture.repository} steps={1} extraProps={["--props-implementation-model","sonnet","--props-implementation-model-evidence",approval]} command={runner} root={root} as="child" />
```bash exec as="unlocked"
chmod 755 {continuations}
```
<If condition={unlocked.exitCode !== 0}><Fail message={unlocked.stderr} /></If>
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="held">{child.stdout}</Parse>
<AssertEquals actual={[held.status,held.publication]} expected={["hold","held"]} />
<AssertEquals actual={held.continuation} expected={plannedReturn.continuation} />
<AssertStringIncludes actual={held.hold} expected="The model selection was not confirmed for publication." />
<Dir path={fixture.directory}><Glob include={["continuations/*.json"]} as="after" /><Glob include={["**/called.json"]} as="called" /></Dir>
<AssertEquals actual={after} expected={before} />
<AssertEquals actual={called} expected={["attempts/0000/called.json"]} />
</TempDir>
</Test>
