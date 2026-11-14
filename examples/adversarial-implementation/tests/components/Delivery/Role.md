---
props: {type: object, properties: {delivery: {type: object}, revision: {type: string}, reviewer: {type: object}, choices: {type: array}, position: {type: integer}, attempt: {type: string}}, required: [delivery, revision, reviewer, choices, position, attempt], additionalProperties: false}
---
<Let as="work" value={props.delivery.work} />
<Let as="primary" value={props.position === 0} />
<Let as="behavior" value={primary ? ({unavailable:"unavailable",configuration:"refused","turn-failed":"turn-failed",exhausted:"turn-failed",partial:"partial","unjoined-primary":"unjoined",outside:"outside",failed:"unjoined"}[work] ?? "reply") : work === "exhausted" ? "refused" : "reply"} />
<Let as="selected" value={{state:"selected",choices:props.choices,model:props.choices[0],advertised:[...props.choices],failure:null}} />
<Let as="verdict" value={work === "blocked" ? "blocked" : work === "repair" ? "changes_required" : "pass"} />
<Let as="review" value={{revision:work === "wrong-head" ? "0".repeat(40) : props.revision,verdict,summary:"Reviewed the assigned behavior.",acceptance:work === "missing-clause" ? [] : props.delivery.policy.acceptance.map(clause => clause.id),findings:["repair","false-pass"].includes(work) ? [{blocking:true,description:"A blocking regression remains."}] : []}} />
<Let as="reply" value={primary && work === "malformed" ? "This is not a review." : JSON.stringify(review)} />
<Let as="base" value={{schema:"delivery-review-outcome.v1",reviewer:props.reviewer,catalog:selected,turn:null}} />
<If condition={work === "completion-repeat"}>
<Agent name={props.reviewer.provider}><Session name={props.reviewer.session} model={selected.model} effort={props.reviewer.effort}><Phase.Session directory={props.delivery.directory + "/sessions"} name={props.reviewer.session}><Prompt throwOnError={true} as="raw"><Json value={{variant:"repeat",review}} /></Prompt></Phase.Session></Session></Agent>
<Dir path={props.attempt}><File path="raw.txt">{raw}</File><File path="outcome.json"><Json value={{...base,turn:{state:"reply",reply:raw}}} /></File></Dir>
<Delivery.Response delivery={props.delivery} revision={props.revision} reviewer={props.reviewer} attempt={props.attempt} raw={raw} dispatch={true} as="response" />
<Else>
<Let as="outcome" value={behavior === "unavailable" ? {...base,catalog:{...selected,state:"unavailable",model:null,advertised:["claude-opus"]}} : behavior === "refused" ? {...base,turn:{state:"failed",stage:"session",failure:"AcpConfigurationError: The agent does not offer the requested model.",partial:"",configuration:{reason:"selector-unavailable",setting:"model"},refusal:null,terminal:null}} : behavior === "turn-failed" ? {...base,turn:{state:"failed",stage:"turn",failure:"AgentPromptError: The provider turn failed.",partial:"",configuration:null,refusal:null,terminal:"failed"}} : behavior === "partial" ? {...base,turn:{state:"failed",stage:"turn",failure:"AgentPromptError: The provider turn failed.",partial:"{\"revision\":",configuration:null,refusal:null,terminal:"failed"}} : behavior === "outside" ? base : {...base,turn:{state:"reply",reply}}} />
<Let as="call" value={{revision:props.revision,reviewer:props.reviewer,position:props.position,prompted:!["unavailable","refused","outside"].includes(behavior)}} />
<Dir path={props.delivery.directory}><Glob include={["called.json"]} as="calledFiles" /></Dir>
<Let as="prior" value={[]} />
<If condition={calledFiles.length !== 0}>
<Ticket.Text path={props.delivery.directory + "/called.json"} as="calledText" />
<Parse schema={{type:"array"}} as="prior">{calledText}</Parse>
</If>
<Dir path={props.delivery.directory}><File path="called.json"><Json value={[...prior,call]} /></File></Dir>
<If condition={behavior === "unjoined"}><Fail message="The original provider operation failed." /></If>
<Dir path={props.attempt}><File path="outcome.json"><Json value={outcome} /></File></Dir>
<If condition={behavior === "outside"}><Fail message="Workflow session identity changed. Reconcile the original conversation before prompting; its identity receipt is unchanged." /></If>
</Else>
</If>
