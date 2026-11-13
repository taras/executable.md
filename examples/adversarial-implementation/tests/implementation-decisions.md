```bash exec as="location"
pwd -P
```
<Let as="root" value={location.stdout.trim()} />

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
