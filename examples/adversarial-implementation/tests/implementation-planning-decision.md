```bash exec as="location"
pwd -P
```
<Let as="root" value={location.stdout.trim()} />

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
