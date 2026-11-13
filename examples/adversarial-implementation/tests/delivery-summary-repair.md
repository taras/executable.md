<Test name="oversized independent summaries repair once in the same conversation and reconcile without prompting" timeout="120s">
<Each in={["accepted","zero","changed","exhausted","invalid"]} let="variant">
<TempDir>
<Fixture.Repository as="fixture" />
<Dir path={fixture.repository}><Fixture.Composition repository={fixture.repository} directory={fixture.directory + "/repositories"}>
```bash exec as="head"
git rev-parse HEAD
```
<Let as="revision" value={head.stdout.trim()} />
<Let as="reviewer" value={{provider:"codex",model:"gpt-6.1-sol",effort:"medium",session:"summary-reviewer"}} />
<Let as="attempt" value={fixture.directory + "/delivery/review-" + revision} />
<Let as="delivery" value={{work:"summary",repository:fixture.repository,directory:fixture.directory + "/delivery",maxResponseCorrections:variant === "zero" ? 0 : 1,inputs:[],policy:{repository:"taras/executable.md",reviewer,acceptance:[{id:"behavior",source:"accepted.md",requirement:"Preserve the accepted behavior."}]}}} />
<Let as="review" value={{revision,verdict:"pass",summary:"x".repeat(1501),acceptance:variant === "invalid" ? [] : ["behavior"],findings:[{blocking:false,description:"Keep this exact observation."}]}} />
<Let as="catalog" value={{state:"selected",choices:[reviewer.model],model:reviewer.model,advertised:[reviewer.model],failure:null}} />
<Delivery.Schema as="schemas" />
<Delivery.Selection delivery={delivery} revision={revision} as="selection" />
<Dir path={attempt}><File path="selection.json"><Json value={selection} /></File></Dir>
<Dir path={attempt}><File path="assignment.json"><Json value={{work:"summary",revision,reviewer,acceptance:delivery.policy.acceptance,responseSchema:schemas.review,maxResponseCorrections:delivery.maxResponseCorrections}} /></File></Dir>
<TestAgent agent="codex">
<TestAgent.Scenario session={reviewer.session} src="./agents/summary-correction.md" models={{selected:reviewer.model,options:[{id:reviewer.model,efforts:{selected:"medium",options:["medium"]}}]}} />
<Agent name="codex"><Session name={reviewer.session} model={reviewer.model} effort="medium"><Phase.Session directory={delivery.directory + "/sessions"} name={reviewer.session}><Prompt throwOnError={true} as="raw"><Json value={{variant,review}} /></Prompt></Phase.Session></Session></Agent>
<Dir path={attempt}><File path="raw.txt">{raw}</File><File path="outcome.json"><Json value={{schema:"delivery-review-outcome.v1",reviewer,catalog,turn:{state:"reply",reply:raw}}} /></File></Dir>
<Ticket.Capture as="execution"><Delivery.Response delivery={delivery} revision={revision} reviewer={reviewer} attempt={attempt} raw={raw} dispatch={true} as="response" /><Json value={response} /></Ticket.Capture>
<If condition={variant === "accepted" && execution.status !== "completed"}><Fail message={execution.failure} /></If>
<AssertEquals actual={execution.status} expected={variant === "accepted" ? "completed" : "failed"} />
<Ticket.Text path={attempt + "/raw.txt"} as="originalRaw" />
<AssertEquals actual={originalRaw} expected={raw} />
<Dir path={attempt}><Glob include={["response-corrections/*/request.json"]} as="corrections" /></Dir>
<AssertEquals actual={corrections.length} expected={["zero","invalid"].includes(variant) ? 0 : 1} />
<If condition={variant === "accepted"}>
<Parse schema={{type:"object"}} as="accepted">{execution.output}</Parse>
<AssertEquals actual={accepted.result} expected={{...review,summary:"The independent findings and verdict remain unchanged."}} />
<Delivery.Response delivery={delivery} revision={revision} reviewer={reviewer} attempt={attempt} raw={raw} dispatch={false} as="reconciled" />
<AssertEquals actual={reconciled} expected={accepted} />
<Dir path={attempt}><File path="execution.json"><Json value={{status:"completed",failure:null}} /></File></Dir>
<Delivery.Reconcile delivery={delivery} revision={revision} publish={true} as="receipt" />
<AssertEquals actual={receipt.result} expected={accepted.result} />
<Delivery.Reconcile delivery={delivery} revision={revision} publish={false} as="readback" />
<AssertEquals actual={readback} expected={receipt} />
<Dir path={attempt + "/response-corrections/0001"}><File path="raw.txt"><Json value={{...accepted.result,findings:[]}} /></File></Dir>
<Ticket.Capture as="tampered"><Delivery.Response delivery={delivery} revision={revision} reviewer={reviewer} attempt={attempt} raw={raw} dispatch={false} /></Ticket.Capture>
<AssertEquals actual={tampered.status} expected="failed" />
</If>
</TestAgent>
</Fixture.Composition></Dir>
</TempDir>
</Each>
</Test>
