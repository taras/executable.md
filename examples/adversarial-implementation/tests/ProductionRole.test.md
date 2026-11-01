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
