```bash exec as="location"
pwd -P
```
<TestAgent>
<TestAgent.Scenario session="independent-proof" src="./agents/independent-review.md" models={{selected:"fixture",options:[{id:"fixture"}]}} />
<Test name="the production review role returns the actual configured prompt reply" timeout="60s">
<Delivery.Role delivery={{repository:location.stdout.trim(),policy:{reviewer:{provider:"test",model:"fixture",effort:null,session:"independent-proof"},acceptance:[{id:"behavior",source:"accepted.md",requirement:"Keep the accepted behavior."}]},inputs:[{path:"accepted.md",content:"The original accepted behavior."}]}} revision={"a".repeat(40)} as="reply" />
<Delivery.Schema as="schemas" />
<Parse schema={schemas.review} as="review">{reply}</Parse>
<AssertEquals actual={review.revision} expected={"a".repeat(40)} />
<AssertEquals actual={review.verdict} expected="pass" />
<AssertEquals actual={review.acceptance} expected={["behavior"]} />
</Test>
</TestAgent>

<TestAgent agent="claude">
<TestAgent.Scenario session="initialized-implementor" src="./agents/initialized-role.md" models={{selected:"sonnet",options:[{id:"sonnet",efforts:{selected:"high",options:["high"]}}]}} />
<Test name="the production role dispatches mandatory initialization but refuses an oversized request before prompting" timeout="60s">
<Let as="assessment" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"Inspect the agreed behavior.",evidence:["accepted.md"]}} />
<Let as="assignment" value={{phase:"implementation",work:"test",repository:location.stdout.trim(),revision:"a".repeat(40),request:"Inspect saved evidence.",assessment}} />
<Phase.Role role="implementor" session="initialized-implementor" assignment={assignment} initialize={true} as="reply" />
<AssertStringIncludes actual={reply} expected="initialization received" />
<Ticket.Capture as="oversized"><Phase.Role role="implementor" session="initialized-implementor" assignment={{...assignment,request:"x".repeat(256000)}} initialize={true} as="unexpected" /></Ticket.Capture>
<AssertEquals actual={oversized.status} expected="failed" />
<AssertStringIncludes actual={oversized.failure} expected="complete phase prompt exceeds 256000" />
</Test>
</TestAgent>
