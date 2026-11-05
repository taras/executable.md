---
props:
  type: object
  properties:
    root: {type: string}
    command: {type: string}
  required: [root, command]
  additionalProperties: false
---

<Let as="root" value={props.root} />
<Let as="runner" value={props.command} />

<Test name="G1 G2 G3 G8 G9 normal launch preserves actual ordinary owners and captured evidence" timeout="90s">
<Each in={[
  {name:"ready existing-interface fix",ready:true,needed:false,architecture:false,provider:"codex"},
  {name:"complex bug stable-evidence",ready:false,needed:false,architecture:false,provider:"codex"},
  {name:"necessary API and consumers ready",ready:true,needed:true,architecture:false},
  {name:"necessary API and consumers unready",ready:false,needed:true,architecture:false},
  {name:"ready structural fix",ready:true,needed:false,architecture:true}
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
<Let as="assessment" value={{mechanical:false,architecture:scenario.architecture,acceptance:true,risk:null,reason:"Inspect the accepted consumer behavior.",evidence:[evidence]}} />
<Let as="task" value={{work:"test",repository:fixture.repository,directory:fixture.directory,revision:base.stdout.trim(),request:scenario.name,inputs:[evidence],sessions:{planner:"original-planner",implementor:"original-implementor",architect:"conditional-architect"},providers:{architect:"codex",planner:scenario.provider ?? "claude",implementor:scenario.provider ?? "claude"},maxResponseCorrections:0,maxCorrections:3,maxApiRepairs:3,assessment,scope:{decisions:{evidence:[evidence],openQuestions:[]},implementation:{ready:scenario.ready,evidence:[evidence]},sharedApi:{needed:scenario.needed,evidence:[evidence]},migration:null}}} />
<Let as="task" value={{...task,delivery:{repository:"taras/executable.md",reviewer:{provider:"claude",model:"fixture",effort:null,session:"independent-review"},acceptance:[{id:"accepted-behavior",source:task.inputs[0],requirement:"Preserve the original accepted behavior."}]}}} />
<If condition={scenario.name === "ready existing-interface fix"}>
<Fixture.Entry entry="run" value={task} command={runner} root={root} as="child" />
<Else>
<Fixture.Execution entry="run" value={task} repository={fixture.repository} root={root} as="child" />
</Else>
</If>
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="work">{child.stdout}</Parse>
<If condition={work.status !== "feedback_ready"}><Fail message={JSON.stringify(work)} /></If>
<Ticket.Load record={work} as="saved" />
<AssertEquals actual={work.remainingRequiredDeliveryWork} expected={["independent-review","required-ci","main-health"]} />
<AssertEquals actual={work.delivery.status} expected="review_pending" />
<Let as="implementationCalls" value={saved.calls.filter(call => call.assignment.phase !== "discovery")} />
<AssertEquals actual={implementationCalls.map(call => call.role)} expected={scenario.architecture ? ["implementor","architect","planner"] : ["implementor","planner"]} />
<AssertEquals actual={implementationCalls.map(call => call.session)} expected={scenario.architecture ? ["original-implementor","conditional-architect","original-planner"] : ["original-implementor","original-planner"]} />
<AssertEquals actual={Object.hasOwn(saved.manifest,"api")} expected={false} />
<AssertEquals actual={saved.manifest.maxCorrections} expected={3} />
<AssertEquals actual={saved.manifest.maxApiRepairs} expected={3} />
<AssertEquals actual={saved.manifest.maxResponseCorrections} expected={0} />
<AssertEquals actual={saved.manifest.roles.planner.provider} expected={task.providers.planner} />
<AssertEquals actual={saved.calls.every(call => call.provider === task.providers[call.role])} expected={true} />
<AssertEquals actual={saved.calls[0].initialize} expected={true} />
<Ticket.Read path={saved.calls[0].attempt + "/called.json"} as="firstCalledText" /><Parse schema={{type:"object"}} as="firstCalled">{firstCalledText}</Parse>
<AssertEquals actual={firstCalled.inputs.find(input => input.path === evidence).content} expected="Evidence A: accepted format behavior and focused consumer checks." />
<AssertEquals actual={implementationCalls.slice(1).every(call => call.assignment.revision === work.revision)} expected={true} />
<Ticket.Signature repository={fixture.repository} revision={work.revision} as="signature" />
<AssertEquals actual={signature.exitCode} expected={0} />
<Ticket.Text path={implementationCalls[0].attempt + "/called.json"} as="implementorText" />
<Parse schema={{type:"object"}} as="implementor">{implementorText}</Parse>
<AssertEquals actual={implementor.initialize} expected={true} />
<AssertEquals actual={implementor.implementationProvider} expected={task.providers.implementor} />
<AssertEquals actual={implementor.revision} expected={task.revision} />
<Dir path={fixture.root}><Glob include={["**/foundation-*/called.json","**/validation.json"]} as="foundations" /></Dir>
<AssertEquals actual={foundations} expected={[]} />
<If condition={scenario.needed || !scenario.ready}>
<Ticket.Text path={fixture.directory + "/attempts/0000/called.json"} as="planningText" />
<Parse schema={{type:"object"}} as="planning">{planningText}</Parse>
<AssertEquals actual={planning.phase} expected="discovery" />
<AssertEquals actual={planning.plannerProvider} expected={task.providers.planner} />
<AssertEquals actual={planning.session} expected="original-planner" />
<AssertEquals actual={planning.initialize} expected={true} />
<AssertEquals actual={planning.revision} expected={task.revision} />
<AssertStringIncludes actual={planning.request} expected="Do not edit or commit source or build an API foundation" />
<Ticket.Text path={fixture.directory + "/attempts/0000/assignment.json"} as="assignmentText" />
<Parse schema={{type:"object"}} as="assignment">{assignmentText}</Parse>
<AssertEquals actual={assignment.continuation} expected={{phase:"implementation",role:"implementor"}} />
<Ticket.Text path={fixture.directory + "/attempts/0000/result.json"} as="planText" />
<Parse schema={{type:"object"}} as="plan">{planText}</Parse>
<AssertEquals actual={plan.outcome} expected="complete" />
<AssertEquals actual={Object.hasOwn(plan,"api")} expected={false} />
<AssertEquals actual={implementationCalls[0].assignment.request} expected={plan.handoff} />
<AssertEquals actual={implementor.inputs.some(input => input.path === plan.handoffInputs[0] && input.content.includes("bash consumer.sh"))} expected={true} />
<AssertEquals actual={saved.checkpoint.initialized.planner} expected={true} />
<AssertEquals actual={saved.calls.at(-1).initialize} expected={false} />
<AssertEquals actual={saved.calls.at(-1).inputs.map(input => input.path)} expected={plan.handoffInputs} />
<AssertEquals actual={saved.deliveredInputs[task.sessions.planner].slice(0,2)} expected={[evidence,task.repository + "/.agents/planner.md"]} />
<Ticket.Text path={fixture.directory + "/attempts/0000/response-acceptance.json"} as="acceptance" />
<AssertStringIncludes actual={acceptance} expected='"round": 0' />
<Ticket.Text path={fixture.directory + "/attempts/0000/raw.txt"} as="raw" />
<AssertStringIncludes actual={raw} expected='"outcome": "complete"' />
<If condition={scenario.name.includes("stable-evidence")}>
<Ticket.Text path={evidence} as="changedEvidence" />
<AssertEquals actual={changedEvidence} expected="Evidence B: mutable original after planning." />
<AssertEquals actual={planning.inputs.find(input => input.path === evidence).content} expected="Evidence A: accepted format behavior and focused consumer checks." />
<AssertEquals actual={implementor.inputs.find(input => input.path === evidence).content} expected="Evidence A: accepted format behavior and focused consumer checks." />
</If>
<Else>
<Dir path={fixture.root}><Glob include={["**/planning/called.json"]} as="planningCalls" /></Dir>
<AssertEquals actual={planningCalls} expected={[]} />
<AssertEquals actual={saved.manifest.roles.planner.initialized} expected={false} />
<AssertEquals actual={saved.calls.at(-1).initialize} expected={true} />
</Else>
</If>
</TempDir>
</Each>
</Test>

<Test name="G6 unavailable evidence source identities policy and occupied work hold without calls" timeout="90s">
<Each in={["unselected","missing-evidence","missing-task","oversized","revision","dirty","sessions","occupied","policy","missing-source"]} let="scenario">
<TempDir>
<Fixture.Repository guides={true} as="fixture" />
<Dir path={fixture.repository}>
```bash exec as="observed"
git rev-parse HEAD
```
</Dir>
<Let as="source" value={{head:observed.stdout.trim()}} />
<Let as="evidence" value={fixture.root + "/accepted.md"} />
<Let as="initialText" value={scenario === "oversized" ? "Accepted evidence. ".repeat(4000) : "Accepted scope and checks."} />
<Dir path={fixture.root}><File path="accepted.md">{initialText}</File></Dir>
<Let as="assessment" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"Inspect the accepted behavior.",evidence:[evidence]}} />
<Let as="task" value={{work:"test",repository:fixture.repository,directory:fixture.directory,revision:source.head,request:"normal",inputs:[evidence],sessions:{planner:"original-planner",implementor:"original-implementor",architect:"conditional-architect"},providers:{architect:"codex",planner:"claude",implementor:"claude"},maxResponseCorrections:0,maxCorrections:3,maxApiRepairs:3,assessment,scope:{decisions:{evidence:[evidence],openQuestions:[]},implementation:{ready:true,evidence:[evidence]},sharedApi:{needed:false,evidence:[evidence]},migration:null}}} />
<Let as="task" value={{...task,delivery:{repository:"taras/executable.md",reviewer:{provider:"claude",model:"fixture",effort:null,session:"independent-review"},acceptance:[{id:"accepted-behavior",source:task.inputs[0],requirement:"Preserve the original accepted behavior."}]}}} />
<Let as="bad" value={scenario === "unselected" ? {...task,scope:{...task.scope,sharedApi:{needed:false,evidence:[fixture.root + "/unselected.md"]}}} : scenario === "missing-evidence" ? {...task,inputs:[evidence,fixture.root + "/missing.md"]} : scenario === "revision" ? {...task,revision:"0".repeat(40)} : scenario === "sessions" ? {...task,sessions:{...task.sessions,planner:task.sessions.implementor}} : scenario === "policy" ? {...task,assessment:{...assessment,mechanical:true}} : scenario === "missing-source" ? {...task,repository:fixture.root + "/absent-repository"} : task} />
<If condition={scenario === "dirty"}><Dir path={fixture.repository}><File path="legacy.fixture">Uncommitted partial source.</File></Dir></If>
<If condition={scenario === "occupied"}><Dir path={fixture.directory}><File path="keep.txt">Preserve this existing record.</File></Dir></If>
<If condition={scenario === "missing-task"}>
<Fixture.Entry entry="run" value={bad} repository={fixture.repository} taskPath={scenario === "missing-task" ? fixture.root + "/absent-task.json" : null} command={runner} root={root} as="child" />
<Else>
<Fixture.Execution entry="run" value={bad} repository={fixture.repository} root={root} as="child" />
</Else>
</If>
<If condition={child.exitCode !== 0}><Fail message={scenario + ": " + child.stderr + child.stdout} /></If>
<Parse schema={{type:"object"}} as="held">{child.stdout}</Parse>
<AssertEquals actual={held.status} expected="hold" />
<AssertEquals actual={held.history} expected={[]} />
<AssertStringIncludes actual={held.reason} expected={scenario === "unselected" ? "unselected.md" : scenario === "missing-evidence" ? "missing.md" : scenario === "missing-task" ? "absent-task.json" : scenario === "oversized" ? "64000" : scenario === "revision" || scenario === "dirty" ? "Source" : scenario === "sessions" ? "sessions" : scenario === "policy" ? "mechanical" : scenario === "missing-source" ? "absent-repository" : "occupied"} />
<Dir path={fixture.root}><Glob include={["**/called.json"]} as="calls" /></Dir>
<AssertEquals actual={calls} expected={[]} />
<If condition={scenario === "occupied"}><Ticket.Text path={fixture.directory + "/keep.txt"} as="kept" /><AssertEquals actual={kept} expected="Preserve this existing record." /></If>
<If condition={scenario === "missing-source"}><Dir path={fixture.root}><Glob include={["absent-repository/**"]} as="created" /></Dir><AssertEquals actual={created} expected={[]} />
<Let as="missingPath" value={"'" + bad.repository.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="absent"
test -d {missingPath}
```
<AssertEquals actual={absent.exitCode} expected={1} />
</If>
</TempDir>
</Each>
</Test>

<Test name="G7 unresolved decisions precede routes and contradictory migration never falls through" timeout="90s">
<TempDir>
<Fixture.Repository guides={true} as="fixture" />
<Dir path={fixture.repository}>
```bash exec as="observed"
git rev-parse HEAD
```
</Dir>
<Let as="source" value={{head:observed.stdout.trim()}} />
<Let as="evidence" value={fixture.root + "/accepted.md"} />
<Dir path={fixture.root}><File path="accepted.md">Accepted scope except any named cancellation choice.</File></Dir>
<Let as="assessment" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"Inspect the accepted behavior.",evidence:[evidence]}} />
<Let as="scope" value={{decisions:{evidence:[evidence],openQuestions:[]},implementation:{ready:true,evidence:[evidence]},sharedApi:{needed:true,evidence:[evidence]},migration:{evidence:[evidence],representativeConsumers:[".agents/planner.md"],remainingConsumers:["legacy.fixture"]}}} />
<Let as="question" value="Does cancellation preserve a completed write?" />
<Each in={[
  {name:"open-simple",scope:{...scope,decisions:{evidence:[evidence],openQuestions:[question]},sharedApi:{needed:false,evidence:[evidence]},migration:null},reason:question},
  {name:"open-migration",scope:{...scope,decisions:{evidence:[evidence],openQuestions:[question]}},reason:question},
  {name:"contradictory",scope:{...scope,sharedApi:{needed:false,evidence:[evidence]}},reason:"sharedApi.needed"},
  {name:"overlap",scope:{...scope,migration:{...scope.migration,remainingConsumers:[".agents/planner.md"]}},reason:"disjoint"},
  {name:"empty-remainder",scope:{...scope,migration:{...scope.migration,remainingConsumers:[]}},reason:"remainingConsumers"},
  {name:"invalid-path",scope:{...scope,migration:{...scope.migration,remainingConsumers:["../other"]}},reason:"remainingConsumers"},
  {name:"missing-consumer",scope:{...scope,migration:{...scope.migration,remainingConsumers:["absent.sh"]}},reason:"absent.sh"}
]} let="scenario">
<Let as="task" value={{work:"test",repository:fixture.repository,directory:fixture.directory,revision:source.head,request:"normal",inputs:[evidence],sessions:{planner:"original-planner",implementor:"original-implementor",architect:"conditional-architect"},providers:{architect:"codex",planner:"claude",implementor:"claude"},maxResponseCorrections:0,maxCorrections:3,maxApiRepairs:3,assessment,scope:scenario.scope}} />
<Let as="task" value={{...task,delivery:{repository:"taras/executable.md",reviewer:{provider:"claude",model:"fixture",effort:null,session:"independent-review"},acceptance:[{id:"accepted-behavior",source:task.inputs[0],requirement:"Preserve the original accepted behavior."}]}}} />
<Fixture.Execution entry="run" value={task} repository={fixture.repository} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={scenario.name + ": " + child.stderr + child.stdout} /></If>
<Parse schema={{type:"object"}} as="held">{child.stdout}</Parse>
<AssertEquals actual={held.status} expected="hold" />
<AssertEquals actual={held.history} expected={[]} />
<AssertStringIncludes actual={held.reason} expected={scenario.reason} />
<If condition={scenario.name.startsWith("open-")}><AssertStringIncludes actual={held.reason} expected={evidence} /></If>
<Dir path={fixture.root}><Glob include={["**/called.json"]} as="calls" /></Dir>
<AssertEquals actual={calls} expected={[]} />
</Each>
</TempDir>
</Test>

<Test name="G8 ordinary planning decision holds with its original phase result and no implementation" timeout="60s">
<TempDir>
<Fixture.Repository guides={true} as="fixture" />
<Dir path={fixture.repository}>
```bash exec as="observed"
git rev-parse HEAD
```
</Dir>
<Let as="source" value={{head:observed.stdout.trim()}} />
<Let as="evidence" value={fixture.root + "/accepted.md"} />
<Dir path={fixture.root}><File path="accepted.md">Accepted initial scope and checks.</File></Dir>
<Let as="assessment" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"Inspect the accepted behavior.",evidence:[evidence]}} />
<Let as="task" value={{work:"test",repository:fixture.repository,directory:fixture.directory,revision:source.head,request:"unanswered-plan-decision",inputs:[evidence],sessions:{planner:"original-planner",implementor:"original-implementor",architect:"conditional-architect"},providers:{architect:"codex",planner:"claude",implementor:"claude"},maxResponseCorrections:0,maxCorrections:3,maxApiRepairs:3,assessment,scope:{decisions:{evidence:[evidence],openQuestions:[]},implementation:{ready:false,evidence:[evidence]},sharedApi:{needed:false,evidence:[evidence]},migration:null}}} />
<Let as="task" value={{...task,delivery:{repository:"taras/executable.md",reviewer:{provider:"claude",model:"fixture",effort:null,session:"independent-review"},acceptance:[{id:"accepted-behavior",source:task.inputs[0],requirement:"Preserve the original accepted behavior."}]}}} />
<Fixture.Execution entry="run" value={task} repository={fixture.repository} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="held">{child.stdout}</Parse>
<AssertEquals actual={held.status} expected="hold" />
<Ticket.Load record={held} as="heldState" />
<AssertStringIncludes actual={heldState.checkpoint.hold.reason} expected="material choice" />
<Ticket.Text path={fixture.directory + "/attempts/0000/result.json"} as="resultText" />
<Parse schema={{type:"object"}} as="result">{resultText}</Parse>
<AssertEquals actual={result.outcome} expected="needs_decision" />
<AssertEquals actual={heldState.checkpoint.hold.reason} expected={result.handoff} />
<Dir path={fixture.root}><Glob include={["**/called.json"]} as="calls" /></Dir>
<AssertEquals actual={calls.length} expected={1} />
<AssertStringIncludes actual={calls[0]} expected="attempts/0000/called.json" />
</TempDir>
</Test>

<Test name="A1 A2 A4 ordinary discovery uses original owners and stops on refused dispositions" timeout="120s">
<Fixture.InitialPlanning root={root} />
</Test>
