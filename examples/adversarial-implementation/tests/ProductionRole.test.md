```bash exec as="location"
pwd -P
```
<TempDir as="identityDirectory" />
<TestAgent>
<TestAgent.Scenario session="independent-proof" src="./agents/independent-review.md" models={{selected:"fixture",options:[{id:"fixture"}]}} />
<Test name="the production review role installs the host-registered acpx provider rather than inheriting the root one" timeout="60s">
<Ticket.Capture as="execution"><Delivery.Role delivery={{directory:identityDirectory + "/delivery",repository:location.stdout.trim(),policy:{reviewer:{provider:"test",model:"fixture",effort:null,session:"independent-proof"},acceptance:[{id:"behavior",source:"accepted.md",requirement:"Keep the accepted behavior."}]},inputs:[{path:"accepted.md",content:"The original accepted behavior."}]}} revision={"a".repeat(40)} reviewer={{provider:"test",model:"fixture",effort:null,session:"independent-proof"}} choices={["fixture"]} position={0} attempt={identityDirectory + "/delivery/review-attempt"} as="outcome" /><Json value={outcome} /></Ticket.Capture>
<AssertEquals actual={execution.status} expected="failed" />
<AssertStringIncludes actual={execution.failure} expected={'Unknown agent provider "acpx"'} />
<Dir path={identityDirectory + "/delivery"}><Glob include={["**"]} as="written" /></Dir>
<AssertEquals actual={written} expected={[]} />
</Test>
</TestAgent>

<TestAgent agent="claude">
<TestAgent.Scenario session="initialized-implementor" src="./agents/initialized-role.md" models={{selected:"opus",options:[{id:"opus",efforts:{selected:"high",options:["high"]}}]}} />
<Test name="the production role dispatches mandatory initialization but refuses an oversized request before prompting" timeout="60s">
<Let as="assessment" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"Inspect the agreed behavior.",evidence:["accepted.md"]}} />
<Let as="assignment" value={{identityDirectory,phase:"implementation",work:"test",repository:location.stdout.trim(),revision:"a".repeat(40),request:"Inspect saved evidence.",assessment}} />
<TempDir as="artifactDirectory" />
<Phase.SubmissionGuide repository={assignment.repository} directory={artifactDirectory}><Phase.SubmissionInstructions role="implementor" assignment={assignment} /></Phase.SubmissionGuide>
<Phase.Role role="implementor" session="initialized-implementor" assignment={{...assignment,artifactDirectory}} initialize={true} as="reply" />
<AssertStringIncludes actual={reply} expected="initialization received" />
<TempDir as="artifactDirectory" />
<Phase.SubmissionGuide repository={assignment.repository} directory={artifactDirectory}><Phase.SubmissionInstructions role="implementor" assignment={assignment} /></Phase.SubmissionGuide>
<Ticket.Capture as="oversized"><Phase.Role role="implementor" session="initialized-implementor" assignment={{...assignment,artifactDirectory,request:"x".repeat(256000)}} initialize={true} as="unexpected" /></Ticket.Capture>
<AssertEquals actual={oversized.status} expected="failed" />
<AssertStringIncludes actual={oversized.failure} expected="complete phase prompt exceeds 256000" />
</Test>
</TestAgent>

<TestAgent>
<TestAgent.Scenario agent="codex" session="sol-planner" src="./agents/sol-medium.md" models={{selected:"fixture-default",options:[{id:"fixture-default"},{id:"gpt-6.1-sol",efforts:{selected:"high",options:["medium","high"]}}]}} />
<TestAgent.Scenario agent="codex" session="sol-implementor" src="./agents/sol-medium.md" models={{selected:"fixture-default",options:[{id:"fixture-default"},{id:"gpt-6.1-sol",efforts:{selected:"high",options:["medium","high"]}}]}} />
<TestAgent.Scenario agent="codex" session="sol-foundation" src="./agents/sol-high.md" models={{selected:"fixture-default",options:[{id:"fixture-default"},{id:"gpt-6.1-sol",efforts:{selected:"medium",options:["medium","high"]}}]}} />
<TestAgent.Scenario agent="claude" session="opus-planner" src="./agents/opus-medium.md" models={{selected:"fixture-default",options:[{id:"fixture-default"},{id:"opus",efforts:{selected:"high",options:["medium","high"]}}]}} />
<TestAgent.Scenario agent="claude" session="opus-foundation" src="./agents/opus-high.md" models={{selected:"fixture-default",options:[{id:"fixture-default"},{id:"opus",efforts:{selected:"medium",options:["medium","high"]}}]}} />
<Test name="production role dispatch honors the selected provider and fixed profile" timeout="60s">
<Let as="assessment" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"Inspect accepted behavior.",evidence:["accepted.md"]}} />
<Let as="assignment" value={{identityDirectory,phase:"discovery",work:"test",repository:location.stdout.trim(),revision:"a".repeat(40),request:"Inspect saved evidence.",assessment}} />
<Phase.Profile role="planner" plannerProvider="codex" assessment={assessment} as="profile" />
<AssertEquals actual={profile} expected={{provider:"codex",model:"gpt-6.1-sol",effort:"medium"}} />
<TempDir as="artifactDirectory" />
<Phase.SubmissionGuide repository={assignment.repository} directory={artifactDirectory}><Phase.SubmissionInstructions role="planner" assignment={{...assignment,phase:"discovery"}} /></Phase.SubmissionGuide>
<Phase.Role role="planner" plannerProvider="codex" session="sol-planner" assignment={{...assignment,artifactDirectory}} as="planner" />
<AssertStringIncludes actual={planner} expected="Sol medium received" />
<TempDir as="artifactDirectory" />
<Phase.SubmissionGuide repository={assignment.repository} directory={artifactDirectory}><Phase.SubmissionInstructions role="planner" assignment={{...assignment,phase:"review"}} /></Phase.SubmissionGuide>
<Phase.Role role="planner" plannerProvider="codex" session="sol-planner" assignment={{...assignment,artifactDirectory,phase:"review"}} as="continued" />
<AssertStringIncludes actual={continued} expected="Sol medium continued" />
<TempDir as="artifactDirectory" />
<Phase.SubmissionGuide repository={assignment.repository} directory={artifactDirectory}><Phase.SubmissionInstructions role="implementor" assignment={{...assignment,phase:"implementation"}} /></Phase.SubmissionGuide>
<Phase.Role role="implementor" implementationProvider="codex" session="sol-implementor" assignment={{...assignment,artifactDirectory,phase:"implementation"}} as="implementor" />
<AssertStringIncludes actual={implementor} expected="Sol medium received" />
<TempDir as="artifactDirectory" />
<Phase.SubmissionGuide repository={assignment.repository} directory={artifactDirectory}><Phase.SubmissionInstructions role="planner" assignment={{...assignment,phase:"discovery"}} /></Phase.SubmissionGuide>
<Phase.Role role="planner" plannerProvider="claude" session="opus-planner" assignment={{...assignment,artifactDirectory}} as="claude" />
<AssertStringIncludes actual={claude} expected="Opus medium received" />
<Each in={["codex","claude"]} let="provider">
<Phase.Profile role="planner" plannerProvider={provider} design={true} assessment={assessment} as="foundation" />
<AssertEquals actual={foundation.provider} expected={provider} />
<AssertEquals actual={foundation.effort} expected="high" />
<Adversarial.PlannerRole assignment={{...assignment,session:provider === "codex" ? "sol-foundation" : "opus-foundation",plannerProvider:provider,initialize:false}} guide="Existing foundation instructions." as="reply" />
<AssertStringIncludes actual={reply} expected={provider === "codex" ? "Sol high received" : "Opus high received"} />
<Adversarial.PlannerRole assignment={{...assignment,session:provider === "codex" ? "sol-foundation" : "opus-foundation",plannerProvider:provider,initialize:false}} guide="" correction={{ordinal:1,remaining:0}} as="repaired" />
<AssertStringIncludes actual={repaired} expected={provider === "codex" ? "Sol high repaired" : "Opus high repaired"} />
</Each>
</Test>
</TestAgent>
