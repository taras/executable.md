```bash exec as="location"
pwd -P
```
<Let as="root" value={location.stdout.trim()} />

<Each in={["null","model","effort","open","close","success"]} let="catalogCase">
<Test name={"fresh Codex catalog admission: " + catalogCase} timeout="60s">
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
<File path=".agents/implementor.md">Implement the accepted fixture plan.</File>
```bash exec as="base"
git add AGENTS.md .agents
git commit -qm 'fixture instructions'
git rev-parse HEAD
```
</Dir>
<Dir path={fixture.root}><File path="accepted.md">Accepted decision-resolution fixture scope.</File></Dir>
<Let as="evidence" value={fixture.root + "/accepted.md"} />
<Let as="assessment" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"Inspect the accepted behavior.",evidence:[evidence]}} />
<Let as="task" value={{work:"test",repository:fixture.repository,directory:fixture.directory,revision:base.stdout.trim(),request:"unanswered-plan-decision",inputs:[evidence],sessions:{planner:"original-planner",implementor:"original-implementor",architect:"conditional-architect"},providers:{architect:"codex",planner:"codex",implementor:"claude"},maxResponseCorrections:0,maxCorrections:3,maxApiRepairs:3,assessment,scope:{decisions:{evidence:[evidence],openQuestions:[]},implementation:{ready:false,evidence:[evidence]},sharedApi:{needed:false,evidence:[evidence]},migration:null}}} />
<Let as="task" value={{...task,delivery:{repository:"taras/executable.md",reviewer:{provider:"claude",model:"fixture",effort:null,session:"independent-review"},acceptance:[{id:"accepted-behavior",source:task.inputs[0],requirement:"Preserve the original accepted behavior."}]}}} />
<File path="task.json"><Json value={task} /></File>
<Let as="other" value={{id:"fixture-other",efforts:{selected:"medium",options:["medium"]}}} />
<Let as="requested" value={{id:"gpt-6.1-sol",efforts:{selected:"low",options:catalogCase === "effort" ? ["low"] : ["low","medium"]}}} />
<Let as="catalog" value={{selected:other.id,options:catalogCase === "model" ? [other] : [catalogCase === "effort" ? other : {...other,efforts:{selected:"low",options:["low"]}},requested]}} />
<Let as="inspection" value={{models:catalogCase === "null" ? null : catalog,...(["open","close"].includes(catalogCase) ? {refuse:catalogCase} : {})}} />
<Dir path={fixture.repository}>
<Let as="expectRole" value={catalogCase === "success"} />
<Execution host="run" target={root + "/examples/adversarial-implementation/run.md"} props={{task:fixture.root + "/task.json"}} as="run">
<TestAgent agent="codex" inspection={inspection}>
<TestAgent.Scenario session="original-planner" src="./agents/decision-planner-held.md" models={catalog} />
</TestAgent>
<CollectOutput as="stdout" />
<If condition={run.kind !== "settled" || !run.result.ok}><Fail message={run.result?.error?.message ?? run.kind} /></If>
<Parse schema={{type:"object"}} as="held">{stdout}</Parse>
<AssertEquals actual={held.status} expected="hold" />
<AssertEquals actual={held.publication === "confirmed"} expected={expectRole} />
<If condition={expectRole}>
<Ticket.Load record={held} as="admissionRecord" />
<AssertEquals actual={admissionRecord.calls.map(call => call.role)} expected={["planner"]} />
<AssertEquals actual={admissionRecord.checkpoint.hold.kind} expected="needs_decision" />
<AssertEquals actual={admissionRecord.checkpoint.hold.reason} expected="ROOT: record the accepted design decision." />
</If>
<If condition={!expectRole}>
<AssertEquals actual={held} expected={{status:"hold",reason:"Codex could not verify model gpt-6.1-sol with effort medium. Correct the Codex profile or launch environment and explicitly submit the same fresh task again.",history:[]}} />
<Dir path={fixture.root}>
```bash exec as="absent"
test ! -e work && test ! -e work.inputs
```
</Dir>
<AssertEquals actual={absent.exitCode} expected={0} />
</If>
</Execution>
</Dir>
</TempDir>
</Test>
</Each>
