```bash exec as="location"
pwd -P
```
<Let as="root" value={location.stdout.trim()} />
```bash exec as="commandSetting"
printf '%s' "$XMD_EXAMPLE_COMMAND"
```
<Let as="runner" value={commandSetting.stdout || "deno run --allow-all '" + root.replaceAll("'","'\"'\"'") + "/packages/cli/src/deno.ts' run"} />

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
  ...["",1,null].map(model => ({name:"invalid-model-" + String(model),value:{...task,implementationModel:model},field:"implementationModel"})),
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

<Test name="A7 an explicit step limit holds on the foundation route before any role or directory" timeout="90s">
<TempDir>
<Fixture.Repository guides={true} as="fixture" />
<Dir path={fixture.repository}>
<File path="wide.sh">printf '%s' 'wide production fixture'
</File>
<File path="consumer.sh">printf '%s' 'remaining production fixture'
</File>
```bash exec as="base"
git add wide.sh consumer.sh
git commit -qm 'existing production consumers'
git rev-parse HEAD
```
<If condition={base.exitCode !== 0}><Fail message={base.stderr} /></If>
</Dir>
<Let as="evidence" value={fixture.root + "/accepted.md"} />
<Dir path={fixture.root}><File path="accepted.md">Accepted repeated production friction.</File></Dir>
<Let as="assessment" value={{mechanical:false,architecture:true,acceptance:true,risk:null,reason:"Inspect the structural foundation and accepted migration.",evidence:[evidence]}} />
<Let as="task" value={{work:"test",repository:fixture.repository,directory:fixture.directory,revision:base.stdout.trim(),request:"normal",inputs:[evidence],sessions:{planner:"original-planner",implementor:"original-implementor",architect:"conditional-architect"},providers:{architect:"codex",planner:"codex",implementor:"codex"},maxResponseCorrections:0,maxCorrections:1,maxApiRepairs:2,assessment,scope:{decisions:{evidence:[evidence],openQuestions:[]},implementation:{ready:true,evidence:[evidence]},sharedApi:{needed:true,evidence:[evidence]},migration:{evidence:[evidence],representativeConsumers:["wide.sh"],remainingConsumers:["consumer.sh"]}}}} />
<Let as="task" value={{...task,delivery:{repository:"taras/executable.md",reviewer:{provider:"claude",model:"fixture",effort:null,session:"independent-review"},acceptance:[{id:"accepted-behavior",source:task.inputs[0],requirement:"Preserve the original accepted behavior."}]}}} />
<Fixture.Entry entry="run" value={task} maxSteps={1} command={runner} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="held">{child.stdout}</Parse>
<AssertEquals actual={held.status} expected="hold" />
<AssertEquals actual={held.reason} expected="An explicit maxSteps boundary is supported for ordinary tickets only. Remove maxSteps for the foundation/migration route." />
<Let as="quotedDirectory" value={"'" + fixture.directory.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="reserved"
test -e {quotedDirectory} -o -L {quotedDirectory}
```
<AssertEquals actual={reserved.exitCode} expected={1} />
<Dir path={fixture.root}><Glob include={["**/called.json"]} as="calls" /></Dir>
<AssertEquals actual={calls} expected={[]} />
</TempDir>
</Test>
