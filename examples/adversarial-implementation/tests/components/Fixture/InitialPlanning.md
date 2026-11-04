---
props:
  type: object
  properties:
    root: {type: string}
  required: [root]
  additionalProperties: false
---

<Let as="root" value={props.root} />
<Each in={["journey","again","decision","blocked","wrong-request","wrong-gap","revision","provider-failure","source-complete","source-decision","source-absent"]} let="scenario">
<TempDir>
<Fixture.Repository guides={true} as="fixture" />
<Dir path={fixture.repository}>
<File path="api.sh">format() { printf '%s' "$1"; }
</File>
```bash exec as="base"
git add api.sh
git -c commit.gpgsign=false commit -qm 'ordinary unsigned planning base'
git rev-parse HEAD
```
<If condition={base.exitCode !== 0}><Fail message={base.stderr} /></If>
</Dir>
<Let as="evidence" value={fixture.root + "/accepted.md"} />
<Dir path={fixture.root}><File path="accepted.md">Accepted ordinary planning scope and frozen checks.</File></Dir>
<Let as="impact" value={{mechanical:false,architecture:true,acceptance:true,risk:null,reason:"Review the accepted routing boundary.",evidence:[evidence]}} />
<Let as="task" value={{work:"ordinary",repository:fixture.repository,directory:fixture.directory,revision:base.stdout.trim(),request:"#1084:" + scenario,inputs:[evidence],sessions:{planner:"original-planner",architect:"original-architect",implementor:"original-implementor"},providers:{architect:"codex",planner:"codex",implementor:"codex"},maxCorrections:3,maxApiRepairs:3,maxResponseCorrections:0,assessment:impact,scope:{decisions:{evidence:[evidence],openQuestions:[]},implementation:{ready:false,evidence:[evidence]},sharedApi:{needed:false,evidence:[evidence]},migration:null},delivery:{repository:"taras/executable.md",reviewer:{provider:"claude",model:"fixture",effort:null,session:"independent-review"},acceptance:[{id:"ordinary",source:evidence,requirement:"Retain the original planning journey."}]}}} />
<Fixture.Execution entry="run" value={task} repository={fixture.repository} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="work">{child.stdout}</Parse>
<If condition={scenario === "again"}>
<AssertEquals actual={work.status} expected="paused" />
<AssertEquals actual={work.dispatchable} expected={true} />
<AssertEquals actual={work.hold} expected={null} />
<AssertEquals actual={work.gate} expected="architect-discovery" />
<AssertEquals actual={work.calls.map(call => call.role)} expected={["planner","architect","planner"]} />
<AssertEquals actual={work.nextAction} expected={{entry:"continue.md",gate:"architect-discovery",action:"continue_feedback"}} />
<AssertEquals actual={work.round} expected={0} />
<Else>
<If condition={scenario === "journey"}>
<If condition={work.status !== "feedback_ready"}><Fail message={JSON.stringify(work)} /></If>
<AssertEquals actual={work.calls.map(call => [call.role,call.assignment.phase,call.initialize])} expected={[["planner","discovery",true],["architect","discovery",true],["planner","discovery",false],["implementor","implementation",true],["architect","review",false],["planner","review",false]]} />
<AssertEquals actual={work.calls.map(call => call.session)} expected={["original-planner","original-architect","original-planner","original-implementor","original-architect","original-planner"]} />
<AssertEquals actual={work.calls.every(call => call.provider === "codex")} expected={true} />
<AssertEquals actual={work.calls.slice(0,3).every(call => call.sourceValue.clean && call.sourceValue.head === task.revision && call.observationValue.signature === null)} expected={true} />
<Let as="contract" value={work.calls[1].resultValue.contract} />
<AssertEquals actual={work.calls.slice(2).every(call => JSON.stringify(call.assignment.contract) === JSON.stringify(contract))} expected={true} />
<AssertEquals actual={work.calls[3].assignment.request} expected={work.calls[2].resultValue.handoff} />
<AssertEquals actual={work.calls[2].inputs.some(input => input.path === work.calls[1].resultValue.handoffInputs[0])} expected={true} />
<AssertEquals actual={work.calls[3].inputs.some(input => input.path === work.calls[2].resultValue.handoffInputs[0])} expected={true} />
<AssertEquals actual={work.calls.slice(4).every(call => call.inputs.some(input => input.path === work.calls[2].resultValue.handoffInputs[0]))} expected={true} />
<AssertEquals actual={work.calls[2].inputs.some(input => input.path === evidence)} expected={false} />
<AssertEquals actual={work.round} expected={0} />
<AssertEquals actual={work.reviews} expected={{architect:work.revision,planner:work.revision}} />
<Ticket.Text path={work.calls[0].attempt + "/raw.txt"} as="raw" />
<AssertStringIncludes actual={raw} expected='"role": "planner"' />
<Ticket.Text path={work.calls[0].attempt + "/response-acceptance.json"} as="accepted" />
<AssertStringIncludes actual={accepted} expected='"round": 0' />
<Else>
<AssertEquals actual={work.status} expected="hold" />
<AssertEquals actual={work.dispatchable} expected={false} />
<AssertEquals actual={work.calls.length} expected={1} />
<AssertEquals actual={work.calls[0].sourceValue.head} expected={task.revision} />
<AssertEquals actual={work.calls[0].sourceValue.clean} expected={!scenario.startsWith("source-")} />
<AssertEquals actual={work.round} expected={0} />
<Fixture.Execution entry="continue" value={work} repository={fixture.repository} steps={1} root={root} as="continuation" />
<If condition={continuation.exitCode !== 0}><Fail message={continuation.stderr || continuation.stdout} /></If>
<Parse schema={{type:"object"}} as="held">{continuation.stdout}</Parse>
<AssertEquals actual={held.calls} expected={work.calls} />
<AssertEquals actual={held.checkpoint} expected={work.checkpoint} />
<AssertEquals actual={held.nextAction.action} expected="resolve_feedback_hold" />
<If condition={["wrong-request","wrong-gap","revision"].includes(scenario)}>
<Ticket.Text path={work.calls[0].attempt + "/response-rejection-0000.json"} as="text" />
<Parse schema={{type:"object"}} as="rejection">{text}</Parse>
<AssertEquals actual={rejection.code} expected={scenario === "revision" ? "metadata-2" : "metadata-8"} />
<Ticket.Text path={work.calls[0].attempt + "/raw.txt"} as="raw" />
<AssertStringIncludes actual={raw} expected={scenario === "revision" ? '"revision"' : '"role": "architect"'} />
<Ticket.Text path={work.calls[0].attempt + "/response-disposition.json"} as="text" />
<Parse schema={{type:"object"}} as="disposition">{text}</Parse>
<AssertEquals actual={{limit:disposition.limit,consumed:disposition.consumed}} expected={{limit:0,consumed:0}} />
<Dir path={work.calls[0].attempt}><Glob include={["result.json","response-corrections/**"]} as="forbidden" /></Dir>
<AssertEquals actual={forbidden} expected={[]} />
</If>
<If condition={scenario.startsWith("source-")}><AssertEquals actual={work.hold.kind} expected="source_mismatch" /></If>
</Else>
</If>
<Dir path={fixture.root}><Glob include={["**/called.json"]} as="calls" /></Dir>
<AssertEquals actual={calls.length} expected={work.calls.length} />
</Else>
</If>
</TempDir>
</Each>
