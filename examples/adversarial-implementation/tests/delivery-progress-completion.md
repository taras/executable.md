<Test name="a joined progress reply gets one same-session completion with a separate formatting allowance" timeout="90s">
<Each in={["pass","format","repeat","unmarked"]} let="variant">
<TempDir>
<Fixture.Repository as="fixture" />
<Dir path={fixture.repository}><Fixture.Composition repository={fixture.repository} directory={fixture.directory + "/repositories"}>
```bash exec as="head"
git rev-parse HEAD
```
<Let as="revision" value={head.stdout.trim()} />
<Let as="reviewer" value={{provider:"codex",model:"gpt-6.1-sol",effort:"medium",session:"completion-reviewer"}} />
<Let as="delivery" value={{work:variant === "repeat" ? "completion-repeat" : "completion",repository:fixture.repository,directory:fixture.directory + "/delivery",maxResponseCorrections:variant === "pass" ? 0 : 1,inputs:[],policy:{repository:"taras/executable.md",reviewer,acceptance:[{id:"behavior",source:"accepted.md",requirement:"Preserve the accepted behavior."}]}}} />
<Let as="attempt" value={delivery.directory + "/review-" + revision} />
<Let as="review" value={{revision,verdict:"pass",summary:variant === "format" ? "x".repeat(1501) : "Review complete.",acceptance:["behavior"],findings:[]}} />
<Let as="catalog" value={{state:"selected",choices:[reviewer.model],model:reviewer.model,advertised:[reviewer.model],failure:null}} />
<TestAgent agent="codex">
<TestAgent.Scenario session={reviewer.session} src="./agents/review-completion.md" models={{selected:reviewer.model,options:[{id:reviewer.model,efforts:{selected:"medium",options:["medium"]}}]}} />
<If condition={variant === "repeat"}>
<Dir path={delivery.directory}><Let as="prepared" value={true} /></Dir>
<Let as="record" value={fixture.directory + "/elicitations.json"} />
<Fixture.Elicitation record={record} hold={attempt + "/hold.json"} mode="answer" answer={{disposition:"hold"}}>
<Delivery.Review delivery={delivery} revision={revision} as="held" />
<AssertEquals actual={held.status} expected="held" />
</Fixture.Elicitation>
<Delivery.Attempts delivery={delivery} revision={revision} as="retained" />
<AssertEquals actual={[retained.state.hold.valid,retained.state.hold.record.chain,retained.state.hold.answer]} expected={[true,"single",{disposition:"hold"}]} />
<AssertStringIncludes actual={retained.state.hold.record.attempts[0].reason} expected="still unfinished after its one completion turn" />
<Dir path={attempt}><Glob include={["raw.txt","completion/raw.txt","replacement/**","response-corrections/**"]} as="replies" /></Dir>
<AssertEquals actual={replies.sort()} expected={["completion/raw.txt","raw.txt"]} />
<Ticket.Text path={record} as="questions" />
<AssertEquals actual={JSON.parse(questions).map(question => question.held)} expected={[true]} />
<Else>
<Delivery.Selection delivery={delivery} revision={revision} as="selection" />
<Dir path={attempt}><File path="selection.json"><Json value={selection} /></File><File path="assignment.json"><Json value={{work:delivery.work,revision,reviewer,acceptance:delivery.policy.acceptance,responseSchema:selection.responseSchema,maxResponseCorrections:delivery.maxResponseCorrections}} /></File></Dir>
<Agent name="codex"><Session name={reviewer.session} model={reviewer.model} effort="medium"><Phase.Session directory={delivery.directory + "/sessions"} name={reviewer.session}><Prompt throwOnError={true} as="raw"><Json value={{variant,review}} /></Prompt></Phase.Session></Session></Agent>
<AssertEquals actual={variant === "unmarked" ? raw.trim() : JSON.parse(raw)} expected={variant === "unmarked" ? "The checks are still running." : {status:"in_progress"}} />
<Dir path={attempt}><File path="raw.txt">{raw}</File><File path="outcome.json"><Json value={{schema:"delivery-review-outcome.v1",reviewer,catalog,turn:{state:"reply",reply:raw}}} /></File></Dir>
<Ticket.Capture as="execution"><Delivery.Response delivery={delivery} revision={revision} reviewer={reviewer} attempt={attempt} raw={raw} dispatch={true} as="response" /><Json value={response} /></Ticket.Capture>
<If condition={["pass","format"].includes(variant) && execution.status !== "completed"}><Fail message={execution.failure} /></If>
<AssertEquals actual={execution.status} expected={["pass","format"].includes(variant) ? "completed" : "failed"} />
<Ticket.Text path={attempt + "/raw.txt"} as="originalRaw" />
<AssertEquals actual={originalRaw} expected={raw} />
<Dir path={attempt}><Glob include={["completion/request.json","response-corrections/*/request.json"]} as="requests" /></Dir>
<AssertEquals actual={requests.sort()} expected={variant === "format" ? ["completion/request.json","response-corrections/0001/request.json"] : variant === "unmarked" ? [] : ["completion/request.json"]} />
<If condition={variant === "pass" || variant === "format"}>
<Dir path={attempt}><File path="execution.json"><Json value={{status:"completed",failure:null}} /></File></Dir>
<Delivery.Reconcile delivery={delivery} revision={revision} publish={true} as="receipt" />
<AssertEquals actual={receipt.result} expected={{...review,summary:"Review complete."}} />
<Delivery.Reconcile delivery={delivery} revision={revision} as="readback" />
<AssertEquals actual={readback} expected={receipt} />
<Ticket.Capture as="duplicate"><Delivery.Response delivery={delivery} revision={revision} reviewer={reviewer} attempt={attempt} raw={raw} dispatch={true} as="unexpected" /></Ticket.Capture>
<If condition={duplicate.status !== "failed" || !duplicate.failure.includes("completion is already reserved")}><Fail message={"Unexpected duplicate result (" + variant + "): " + duplicate.failure} /></If>
</If>
</Else>
</If>
</TestAgent>
</Fixture.Composition></Dir>
</TempDir>
</Each>
</Test>
