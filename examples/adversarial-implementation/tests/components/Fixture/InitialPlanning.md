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
<Ticket.Load record={work} as="saved" />
<If condition={scenario === "again"}>
<AssertEquals actual={work.status} expected="paused" />
<AssertEquals actual={saved.checkpoint.dispatchable} expected={true} />
<AssertEquals actual={saved.checkpoint.hold} expected={null} />
<AssertEquals actual={saved.checkpoint.gate} expected="architect-discovery" />
<AssertEquals actual={saved.calls.map(call => call.role)} expected={["planner","architect","planner"]} />
<AssertEquals actual={work.nextAction} expected={{entry:"continue.md",gate:"architect-discovery",action:"continue_feedback"}} />
<AssertEquals actual={saved.checkpoint.round} expected={0} />
<Else>
<If condition={scenario === "journey"}>
<If condition={work.status !== "feedback_ready"}><Fail message={JSON.stringify(work)} /></If>
<AssertEquals actual={saved.calls.map(call => [call.role,call.assignment.phase,call.initialize])} expected={[["planner","discovery",true],["architect","discovery",true],["planner","discovery",false],["implementor","implementation",true],["architect","review",false],["planner","review",false]]} />
<AssertEquals actual={saved.calls.map(call => call.session)} expected={["original-planner","original-architect","original-planner","original-implementor","original-architect","original-planner"]} />
<AssertEquals actual={saved.calls.every(call => call.provider === "codex")} expected={true} />
<Let as="sourceIndex" value={0} />
<Loop max={3}>
<Ticket.Read path={saved.calls[sourceIndex].source} as="sourceText" /><Parse schema={{type:"object"}} as="sourceReceipt">{sourceText}</Parse>
<Parse schema={{type:"object"}} as="source">{sourceReceipt.output}</Parse>
<Ticket.Read path={saved.calls[sourceIndex].observation} as="observationText" /><Parse schema={{type:"object"}} as="observation">{observationText}</Parse>
<AssertEquals actual={{clean:source.clean,head:source.head,signature:observation.signature}} expected={{clean:true,head:task.revision,signature:null}} />
<Let as="sourceIndex" value={sourceIndex + 1} />
</Loop>
<Ticket.Read path={saved.calls[1].result} as="architectResultText" /><Parse schema={{type:"object"}} as="architectResult">{architectResultText}</Parse>
<Ticket.Read path={saved.calls[2].result} as="plannerResultText" /><Parse schema={{type:"object"}} as="plannerResult">{plannerResultText}</Parse>
<Let as="contract" value={architectResult.contract} />
<AssertEquals actual={saved.calls.slice(2).every(call => JSON.stringify(call.assignment.contract) === JSON.stringify(contract))} expected={true} />
<AssertEquals actual={saved.calls[3].assignment.request} expected={plannerResult.handoff} />
<AssertEquals actual={saved.calls[2].inputs.some(input => input.path === architectResult.handoffInputs[0])} expected={true} />
<AssertEquals actual={saved.calls[3].inputs.some(input => input.path === plannerResult.handoffInputs[0])} expected={true} />
<AssertEquals actual={saved.calls.slice(4).every(call => call.inputs.some(input => input.path === plannerResult.handoffInputs[0]))} expected={true} />
<AssertEquals actual={saved.calls[2].inputs.some(input => input.path === evidence)} expected={false} />
<AssertEquals actual={saved.checkpoint.round} expected={0} />
<AssertEquals actual={saved.checkpoint.reviews} expected={{architect:work.revision,planner:work.revision}} />
<Ticket.Text path={saved.calls[0].attempt + "/raw.txt"} as="raw" />
<AssertStringIncludes actual={raw} expected='"role": "planner"' />
<Ticket.Text path={saved.calls[0].attempt + "/response-acceptance.json"} as="accepted" />
<AssertStringIncludes actual={accepted} expected='"round": 0' />
<Else>
<AssertEquals actual={work.status} expected="hold" />
<AssertEquals actual={saved.checkpoint.dispatchable} expected={false} />
<AssertEquals actual={saved.calls.length} expected={1} />
<Ticket.Read path={saved.calls[0].source} as="sourceText" /><Parse schema={{type:"object"}} as="sourceReceipt">{sourceText}</Parse><Parse schema={{type:"object"}} as="source">{sourceReceipt.output}</Parse>
<AssertEquals actual={source.head} expected={task.revision} />
<AssertEquals actual={source.clean} expected={!scenario.startsWith("source-")} />
<AssertEquals actual={saved.checkpoint.round} expected={0} />
<Fixture.Execution entry="continue" value={work} repository={fixture.repository} steps={1} root={root} as="continuation" />
<If condition={continuation.exitCode !== 0}><Fail message={continuation.stderr || continuation.stdout} /></If>
<Parse schema={{type:"object"}} as="held">{continuation.stdout}</Parse>
<Ticket.Load record={held} as="heldState" />
<AssertEquals actual={heldState.calls} expected={saved.calls} />
<AssertEquals actual={heldState.checkpoint} expected={saved.checkpoint} />
<AssertEquals actual={held.nextAction.action} expected="resolve_feedback_hold" />
<If condition={["wrong-request","wrong-gap","revision"].includes(scenario)}>
<Ticket.Text path={saved.calls[0].attempt + "/response-rejection-0000.json"} as="text" />
<Parse schema={{type:"object"}} as="rejection">{text}</Parse>
<AssertEquals actual={rejection.code} expected={scenario === "revision" ? "metadata-2" : "metadata-8"} />
<Ticket.Text path={saved.calls[0].attempt + "/raw.txt"} as="raw" />
<AssertStringIncludes actual={raw} expected={scenario === "revision" ? '"revision"' : '"role": "architect"'} />
<Ticket.Text path={saved.calls[0].attempt + "/response-disposition.json"} as="text" />
<Parse schema={{type:"object"}} as="disposition">{text}</Parse>
<AssertEquals actual={{limit:disposition.limit,consumed:disposition.consumed}} expected={{limit:0,consumed:0}} />
<Dir path={saved.calls[0].attempt}><Glob include={["result.json","response-corrections/**"]} as="forbidden" /></Dir>
<AssertEquals actual={forbidden} expected={[]} />
</If>
<If condition={scenario.startsWith("source-")}><AssertEquals actual={saved.checkpoint.hold.kind} expected="source_mismatch" /></If>
</Else>
</If>
<Dir path={fixture.root}><Glob include={["**/called.json"]} as="calls" /></Dir>
<AssertEquals actual={calls.length} expected={saved.calls.length} />
</Else>
</If>
</TempDir>
</Each>
