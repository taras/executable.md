```bash exec as="location"
pwd -P
```
<Let as="root" value={location.stdout.trim()} />

<Each in={["continued","missing"]} let="variant">
<Test name={"DR1 native " + variant + ": a resolved Planner decision continues only the established native session"} timeout="180s">
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
<Let as="impact" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"Preserve the accepted decision route.",evidence:[fixture.root + "/accepted.md"]}} />
<Let as="manifest" value={{schema:"ticket-workflow.v2",work:"decision-native",directory:fixture.directory,roles:{planner:{session:"decision-planner",provider:"codex",initialized:false},architect:{session:"decision-architect",provider:"codex",initialized:false},implementor:{session:"decision-implementor",provider:"codex",initialized:false}},maxCorrections:3,maxApiRepairs:0,maxResponseCorrections:0,acceptedInputs:[{path:fixture.root + "/accepted.md",content:"Accepted decision-resolution fixture scope."}],roleInputs:{},assignment:{phase:"discovery",work:"decision-native",repository:fixture.repository,revision:base.stdout.trim(),priorRevision:null,request:"Plan the accepted fixture scope.",assessment:impact,artifacts:[],evidence:[],findings:[],changedPaths:[],recipient:"planner",continuation:{phase:"implementation",role:"implementor"}}}} />
<File path="manifest.json"><Json value={manifest} /></File>
<Let as="journeyText">
<Dir path={fixture.repository}>
<Execution host="run" target={root+"/examples/adversarial-implementation/tests/decision-native-journey.md"} props={{manifest:fixture.root+"/manifest.json",root:fixture.root,variant}}>
<TestAgent>
<TestAgent.Scenario agent="codex" session="decision-planner" src={variant === "continued" ? "./agents/decision-planner.md" : "./agents/decision-planner-held.md"} models={{selected:"gpt-6.1-sol",options:[{id:"gpt-6.1-sol",efforts:{selected:"medium",options:["medium","high"]}}]}} />
</TestAgent>
<CollectOutput as="stdout" />
{stdout}
</Execution>
</Dir>
</Let>
<Parse schema={{type:"object"}} as="journey">{journeyText}</Parse>
<Parse schema={{type:"object"}} as="identity">{journey.identityBefore}</Parse>
<AssertEquals actual={[journey.held.checkpoint.hold.kind,journey.heldReturn.nextAction.action,journey.held.calls.length]} expected={["needs_decision","resolve_decision",1]} />
<AssertEquals actual={[identity.schema,identity.name,identity.cwd,identity.attempted,identity.identity === null]} expected={["phase-session.v2","decision-planner",fixture.repository,true,false]} />
<AssertEquals actual={journey.identityResolved === journey.identityBefore} expected={true} />
<AssertEquals actual={[journey.resolvedReturn.publication,journey.continued.calls.slice(0,1)]} expected={["confirmed",journey.held.calls]} />
<Let as="resumed" value={journey.continued.calls[1]} />
<AssertEquals actual={[resumed.role,resumed.session,resumed.provider,resumed.initialize,resumed.assignment.phase]} expected={["planner","decision-planner","codex",false,"discovery"]} />
<If condition={variant === "continued"}>
<AssertEquals actual={[journey.identityAfter.status,JSON.parse(journey.identityAfter.output) === journey.identityBefore]} expected={["completed",true]} />
<AssertEquals actual={[resumed.status,resumed.delivery,journey.continued.checkpoint.gate,journey.continuedReturn.status]} expected={["accepted",fixture.directory + "/attempts/0001/delivery.json","implementation","paused"]} />
<Ticket.Text path={resumed.delivery} as="deliveryText" /><Parse schema={{type:"object"}} as="delivered">{deliveryText}</Parse>
<AssertEquals actual={[delivered.session,delivered.inputs.map(input => input.path)]} expected={["decision-planner",[fixture.root + "/decision.md",fixture.root + "/provenance.md"]]} />
<Else>
<AssertEquals actual={[journey.identityAfter.status,resumed.status,journey.continued.checkpoint.hold.kind,journey.continued.checkpoint.dispatchable]} expected={["failed","failed_without_result","execution_failure",false]} />
<AssertStringIncludes actual={journey.continued.checkpoint.hold.reason} expected="identity receipt is unavailable" />
<Dir path={fixture.directory + "/attempts/0001"}><Glob include={["raw.txt","result.json","delivery.json"]} as="effects" /></Dir>
<AssertEquals actual={effects} expected={[]} />
</Else>
</If>
</TempDir>
</Test>
</Each>
