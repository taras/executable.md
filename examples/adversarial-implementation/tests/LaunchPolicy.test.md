```bash exec as="location"
pwd -P
```
<Let as="root" value={location.stdout.trim()} />
```bash exec as="commandSetting"
printf '%s' "$XMD_EXAMPLE_COMMAND"
```
<Let as="runner" value={commandSetting.stdout || "deno run --allow-all '" + root.replaceAll("'","'\"'\"'") + "/packages/cli/src/deno.ts' run"} />

<Test name="G4 migration validates representatives and structural foundation before remainder and retirement" timeout="90s">
<Each in={[{request:"normal",limit:0},{request:"response-repair",limit:1},{request:"response-repair",limit:0}]} let="scenario">
<TempDir>
<Fixture.Repository guides={true} as="fixture" />
<Dir path={fixture.repository}>
<File path="wide.sh">printf '%s' 'wide production fixture'
</File>
<File path="modal.sh">printf '%s' 'difficult modal production fixture'
</File>
<File path="consumer.sh">printf '%s' 'remaining production fixture'
</File>
```bash exec as="base"
git add wide.sh modal.sh consumer.sh
git commit -qm 'existing production consumers'
git rev-parse HEAD
```
<If condition={base.exitCode !== 0}><Fail message={base.stderr} /></If>
</Dir>
<Let as="evidence" value={fixture.root + "/accepted.md"} />
<Dir path={fixture.root}><File path="accepted.md">Accepted repeated production friction in wide and the difficult modal case; substantial remaining conversion in consumer.sh.</File></Dir>
<Let as="assessment" value={{mechanical:false,architecture:true,acceptance:true,risk:null,reason:"Inspect the structural foundation and accepted migration.",evidence:[evidence]}} />
<Let as="task" value={{work:"test",repository:fixture.repository,directory:fixture.directory,revision:base.stdout.trim(),request:scenario.request,inputs:[evidence],sessions:{planner:"original-planner",implementor:"original-implementor",architect:"conditional-architect"},providers:{architect:"codex",planner:"codex",implementor:"codex"},maxResponseCorrections:scenario.limit,maxCorrections:1,maxApiRepairs:2,assessment,scope:{decisions:{evidence:[evidence],openQuestions:[]},implementation:{ready:true,evidence:[evidence]},sharedApi:{needed:true,evidence:[evidence]},migration:{evidence:[evidence],representativeConsumers:["wide.sh","modal.sh"],remainingConsumers:["consumer.sh"]}}}} />
<Let as="task" value={{...task,delivery:{repository:"taras/executable.md",reviewer:{provider:"claude",model:"fixture",effort:null,session:"independent-review"},acceptance:[{id:"accepted-behavior",source:task.inputs[0],requirement:"Preserve the original accepted behavior."}]}}} />
<Fixture.Entry entry="run" value={task} command={runner} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="work">{child.stdout}</Parse>
<If condition={scenario.request === "response-repair" && scenario.limit === 0}>
<AssertEquals actual={work.status} expected="hold" />
<Ticket.Text path={fixture.directory + "/foundation-0/response-disposition.json"} as="text" />
<Parse schema={{type:"object"}} as="disposition">{text}</Parse>
<AssertEquals actual={disposition.limit} expected={0} />
<AssertEquals actual={disposition.consumed} expected={0} />
<Dir path={fixture.directory}><Glob include={["**/response-corrections/**/called.json","**/migration.json"]} as="extraCalls" /></Dir>
<AssertEquals actual={extraCalls} expected={[]} />
<Else>
<If condition={work.status !== "feedback_ready"}><Fail message={JSON.stringify(work)} /></If>
<AssertEquals actual={work.history.map(item => item.owner)} expected={["planner","implementor"]} />
<Ticket.Text path={fixture.directory + "/foundation-0/called.json"} as="foundationText" />
<Parse schema={{type:"object"}} as="foundation">{foundationText}</Parse>
<AssertEquals actual={foundation.session} expected="original-planner" />
<AssertEquals actual={foundation.plannerProvider} expected="codex" />
<AssertEquals actual={foundation.maxResponseCorrections} expected={scenario.limit} />
<If condition={scenario.limit === 1}>
<Ticket.Text path={fixture.directory + "/foundation-0/response-corrections/1/called.json"} as="repairText" />
<Parse schema={{type:"object"}} as="repair">{repairText}</Parse>
<AssertEquals actual={repair.session} expected="original-planner" />
<AssertEquals actual={repair.plannerProvider} expected="codex" />
<AssertEquals actual={repair.remaining} expected={0} />
</If>
<AssertEquals actual={foundation.initialize} expected={true} />
<AssertEquals actual={foundation.inputs[0].content} expected="Accepted repeated production friction in wide and the difficult modal case; substantial remaining conversion in consumer.sh." />
<AssertStringIncludes actual={foundation.request} expected='"representativeConsumers":["wide.sh","modal.sh"]' />
<Ticket.Text path={fixture.directory + "/foundation-0/validation.json"} as="validationText" />
<Parse schema={{type:"object"}} as="validation">{validationText}</Parse>
<AssertEquals actual={validation.checks.length} expected={2} />
<AssertEquals actual={validation.checks.every(check => check.outcome === "passed")} expected={true} />
<Each in={[0,1]} let="index">
<Ticket.Text path={fixture.directory + "/foundation-0/example-" + index + ".json"} as="commandText" />
<Parse schema={{type:"object"}} as="command">{commandText}</Parse>
<AssertEquals actual={command.exitCode} expected={0} />
</Each>
<Ticket.Text path={fixture.directory + "/foundation-review-1/called.json"} as="reviewText" />
<Parse schema={{type:"object"}} as="review">{reviewText}</Parse>
<AssertEquals actual={review.role} expected="architect" />
<AssertEquals actual={review.revision} expected={work.api.revision} />
<AssertEquals actual={review.initialize} expected={true} />
<AssertEquals actual={work.ticket.calls.map(call => call.role)} expected={["implementor","architect","planner"]} />
<AssertEquals actual={work.ticket.calls.map(call => call.initialize)} expected={[true,false,false]} />
<AssertEquals actual={work.ticket.calls[0].assignment.revision} expected={work.api.revision} />
<AssertEquals actual={work.ticket.calls[0].inputs.find(input => input.path === evidence).content} expected={foundation.inputs[0].content} />
<AssertEquals actual={work.ticket.manifest.maxCorrections} expected={1} />
<AssertEquals actual={work.ticket.manifest.maxApiRepairs} expected={2} />
<AssertEquals actual={work.ticket.manifest.maxResponseCorrections} expected={scenario.limit} />
<AssertEquals actual={work.ticket.manifest.roles.planner.provider} expected="codex" />
<AssertEquals actual={work.ticket.calls.filter(call => call.role !== "architect").every(call => call.provider === "codex")} expected={true} />
<Ticket.Text path={fixture.directory + "/retirement.json"} as="retirement" />
<AssertStringIncludes actual={retirement} expected="legacy.fixture" />
</Else>
</If>
</TempDir>
</Each>
</Test>

<Test name="G5 malformed missing mistyped and extra launch fields hold before roles" timeout="90s">
<TempDir>
<Fixture.Repository guides={true} as="fixture" />
<Dir path={fixture.repository}>
```bash exec as="observed"
git rev-parse HEAD
```
</Dir>
<Let as="source" value={{head:observed.stdout.trim()}} />
<Let as="evidence" value={fixture.root + "/accepted.md"} />
<Dir path={fixture.root}><File path="accepted.md">Accepted scope and checks.</File></Dir>
<Let as="assessment" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"Inspect the accepted behavior.",evidence:[evidence]}} />
<Let as="task" value={{work:"test",repository:fixture.repository,directory:fixture.directory,revision:source.head,request:"normal",inputs:[evidence],sessions:{planner:"original-planner",implementor:"original-implementor",architect:"conditional-architect"},providers:{architect:"codex",planner:"claude",implementor:"claude"},maxResponseCorrections:0,maxCorrections:3,maxApiRepairs:3,assessment,scope:{decisions:{evidence:[evidence],openQuestions:[]},implementation:{ready:true,evidence:[evidence]},sharedApi:{needed:false,evidence:[evidence]},migration:null}}} />
<Let as="task" value={{...task,delivery:{repository:"taras/executable.md",reviewer:{provider:"claude",model:"fixture",effort:null,session:"independent-review"},acceptance:[{id:"accepted-behavior",source:task.inputs[0],requirement:"Preserve the original accepted behavior."}]}}} />
<Each in={[
  {name:"malformed",raw:"{ broken",field:"parse"},
  ...["decisions","implementation","sharedApi","migration"].map(group => ({name:"missing-" + group,value:{...task,scope:Object.fromEntries(Object.entries(task.scope).filter(([key]) => key !== group))},field:group})),
  ...["providers","maxCorrections","maxApiRepairs","maxResponseCorrections"].map(field => ({name:"missing-" + field,value:Object.fromEntries(Object.entries(task).filter(([key]) => key !== field)),field})),
  ...[-1,0.5,4,"0"].map(limit => ({name:"invalid-response-" + limit,value:{...task,maxResponseCorrections:limit},field:"maxResponseCorrections"})),
  {name:"invalid-provider",value:{...task,providers:{...task.providers,planner:"other"}},field:"planner"},
  {name:"missing-member",value:{...task,scope:{...task.scope,implementation:{evidence:[evidence]}}},field:"ready"},
  {name:"string-boolean",value:{...task,scope:{...task.scope,implementation:{...task.scope.implementation,ready:"false"}}},field:"ready"},
  {name:"unknown-scope",value:{...task,scope:{...task.scope,settled:true}},field:"settled"},
  ...["mode","full","phase"].map(field => ({name:"override-" + field,value:{...task,[field]:field === "full" ? true : "migration"},field}))
]} let="scenario">
<Fixture.Entry entry="run" value={scenario.value ?? task} raw={scenario.raw ?? JSON.stringify(scenario.value)} command={runner} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={scenario.name + ": " + child.stderr + child.stdout} /></If>
<Parse schema={{type:"object"}} as="held">{child.stdout}</Parse>
<AssertEquals actual={held.status} expected="hold" />
<AssertEquals actual={held.history} expected={[]} />
<AssertStringIncludes actual={held.reason} expected={scenario.field} />
<Dir path={fixture.root}><Glob include={["**/called.json"]} as="calls" /></Dir>
<AssertEquals actual={calls} expected={[]} />
</Each>
</TempDir>
</Test>

<Test name="the documented task uses the accepted closed launch contract">
<File path="examples/adversarial-implementation/task.example.json" as="text" />
<Adversarial.Schema as="schemas" />
<SafeParse schema={schemas.launch} as="parsed">{text}</SafeParse>
<AssertEquals actual={parsed.ok} expected={true} />
</Test>
