```bash exec as="location"
pwd -P
```
<Let as="root" value={location.stdout.trim()} />
```bash exec as="commandSetting"
printf '%s' "$XMD_EXAMPLE_COMMAND"
```
<Let as="runner" value={commandSetting.stdout || "deno run --node-modules-dir=manual --cached-only --allow-all '" + root.replaceAll("'","'\"'\"'") + "/packages/cli/src/deno.ts' run"} />
<Let as="assessment" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"Inspect the agreed behavior.",evidence:["accepted.md"]}} />

<Test name="delivery requires explicit obligations and original acceptance sources">
<Let as="task" value={{work:"test",repository:"/source",directory:"/work",inputs:["accepted.md"],sessions:{planner:"planner",implementor:"implementor",architect:"architect"}}} />
<Let as="policy" value={{repository:"taras/executable.md",reviewer:{provider:"claude",model:"fixture",effort:null,session:"independent"},acceptance:[{id:"behavior",source:"accepted.md",requirement:"Keep the accepted behavior."}]}} />
<Each in={[{},policy,{...policy,reviewer:{...policy.reviewer,session:"implementor"}},{...policy,acceptance:[]},{...policy,acceptance:[{...policy.acceptance[0],source:"invented-gate.md"}]},{...policy,acceptance:[policy.acceptance[0],policy.acceptance[0]]}]} let="candidate">
<Ticket.Capture as="execution"><Delivery.Prepare task={{...task,delivery:candidate}} inputs={[{path:"accepted.md",content:"The original behavior."}]} as="prepared" /><Json value={prepared} /></Ticket.Capture>
<AssertEquals actual={execution.status === "completed"} expected={JSON.stringify(candidate) === JSON.stringify(policy)} />
</Each>
</Test>

<Test name="joined exact-head review is necessary and its verdict drives the next action" timeout="90s">
<Each in={["pass","repair","blocked","wrong-head","missing-clause","false-pass","failed","unjoined","empty"]} let="scenario">
<TempDir>
<Fixture.Repository as="fixture" />
<Fixture.Entry entry="delivery-case" value={{scenario,fixture,runner,root}} repository={fixture.repository} command={runner} root={root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={scenario + ": " + child.stderr + child.stdout} /></If>
</TempDir>
</Each>
</Test>

<Test name="CI selection shares the exact-main rule and follows newer attempts">
<Let as="revision" value={"a".repeat(40)} />
<Let as="run" value={{id:1,run_number:4,run_attempt:1,status:"completed",conclusion:"success",head_sha:revision,head_branch:"main",event:"push",name:"CI",html_url:"https://example.invalid/run/1",actor:{login:"test"}}} />
<Delivery.SelectRuns revision={revision} mainRevision={revision} prPages={[{workflow_runs:[{...run,event:"pull_request"}]}]} mainPages={[{workflow_runs:[run,{...run,id:2,run_number:5,run_attempt:2,status:"in_progress",conclusion:null},{...run,id:3,run_number:99,head_sha:"b".repeat(40)},{...run,id:4,run_number:100,event:"pull_request"},{...run,id:5,run_number:101,name:"Other"}]}]} as="selected" />
<AssertEquals actual={selected.main.id} expected={2} />
<AssertEquals actual={selected.main.status} expected="in_progress" />
<AssertEquals actual={selected.ci.id} expected={1} />
</Test>

<Test name="assignment metadata is supplied without inventing evidence or replacing conflicts">
<Let as="assignment" value={{phase:"review",work:"test",revision:"a".repeat(40),continuation:{phase:"ready",role:null}}} />
<Phase.Metadata assignment={assignment} value={{outcome:"pass",evidence:[]}} as="prepared" />
<AssertEquals actual={prepared} expected={{phase:"review",work:"test",revision:assignment.revision,next:assignment.continuation,outcome:"pass",evidence:[]}} />
<Phase.Metadata assignment={assignment} value={{phase:"implementation",work:"another",revision:"b".repeat(40),outcome:"pass",next:{phase:"hold",role:null}}} as="conflicting" />
<AssertEquals actual={conflicting.work} expected="another" />
<AssertEquals actual={conflicting.revision} expected={"b".repeat(40)} />
<Phase.Metadata assignment={{...assignment,phase:"implementation"}} value={{outcome:"complete"}} as="implementation" />
<AssertEquals actual={Object.hasOwn(implementation,"revision")} expected={false} />
</Test>

<Test name="the complete prompt is bounded before native dispatch">
<Let as="assignment" value={{phase:"review",work:"test",repository:"/source",revision:"a".repeat(40),request:"Inspect saved evidence.",assessment}} />
<Ticket.Capture as="prepared"><Phase.Request role="planner" assignment={assignment} inputs={[{path:"large.md",content:"x".repeat(64000)}]} as="request" /></Ticket.Capture>
<AssertEquals actual={prepared.status} expected="failed" />
<AssertStringIncludes actual={prepared.failure} expected="complete phase prompt exceeds 64000" />
</Test>
